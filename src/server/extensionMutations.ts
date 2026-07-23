import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { HlidConfig } from "../config";
import { writeFileAtomicSync } from "../lib/atomicFile";
import { resolveClaudeExecutable } from "../lib/claudePath";
import { resolveCodexExecutable } from "../lib/codexPath";
import { parseWslUncSyntax } from "../lib/paths";
import { runBoundedProcess } from "../lib/process";
import {
	discoverExtensionInventory,
	type ExtensionProviderId,
	extensionEnvironmentId,
	type ProviderExtensionHome,
	type ProviderMarketplace,
	providerExtensionHomes,
	reviewAvailableExtension,
} from "./extensionInventory";
import { writeWrapper } from "./wrappers";

const MUTATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 32_000;
const PLUGIN_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const MAX_MARKETPLACE_SOURCE_CHARS = 2_048;
const MAX_SPARSE_PATHS = 20;
const MAX_SPARSE_PATH_CHARS = 512;
const MARKETPLACE_UPDATE_RETRY_DELAY_MS = 750;
const activeMutations = new Set<string>();

export type ExtensionMutationInput =
	| {
			action: "install";
			id: string;
			reviewToken: string;
	  }
	| {
			action: "uninstall";
			id: string;
			expectedVersion: string;
	  }
	| {
			action: "set_enabled";
			id: string;
			expectedVersion: string;
			expectedEnabled: boolean;
			enabled: boolean;
	  }
	| {
			action: "add_marketplace";
			providerId: ExtensionProviderId;
			environmentId: string;
			source: string;
			ref?: string;
			sparse?: string[];
	  }
	| {
			action: "upgrade_marketplace";
			id: string;
			expectedSource: string;
	  }
	| {
			action: "remove_marketplace";
			id: string;
			expectedSource: string;
	  };

export type ExtensionMutationResult = {
	action: ExtensionMutationInput["action"];
	providerId: ExtensionProviderId;
	subject: string;
	pluginId?: string;
	environmentLabel: string;
	output: string;
};

type LocatedExtension = {
	home: ProviderExtensionHome;
	providerId: ExtensionProviderId;
	pluginId: string;
	environmentLabel: string;
	scope: string;
	version: string;
	enabled: boolean;
};

type LocatedMarketplace = {
	home: ProviderExtensionHome;
	marketplace: ProviderMarketplace;
};

type MutationCommand = {
	executable: string;
	args: string[];
	cwd?: string;
	shell: boolean;
	displayCommand: string;
};

export type ExtensionMutationDependencies = {
	homes?: (config: HlidConfig) => ProviderExtensionHome[];
	discover?: typeof discoverExtensionInventory;
	review?: typeof reviewAvailableExtension;
	run?: typeof runBoundedProcess;
	resolveClaude?: () => string | undefined;
	resolveCodex?: () => string | undefined;
	writeProviderWrapper?: (
		homePath: string,
		command: "claude" | "codex",
	) => string | null;
	wait?: (milliseconds: number) => Promise<void>;
	setCodexPluginEnabled?: typeof setCodexPluginEnabled;
};

function validatePluginId(pluginId: string): void {
	const separator = pluginId.lastIndexOf("@");
	const name = pluginId.slice(0, separator);
	const marketplace = pluginId.slice(separator + 1);
	if (
		separator <= 0 ||
		separator === pluginId.length - 1 ||
		!PLUGIN_PART_RE.test(name) ||
		!PLUGIN_PART_RE.test(marketplace)
	) {
		throw new Error("The provider returned an unsupported plugin identifier");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setCodexPluginEnabled(
	configPath: string,
	pluginId: string,
	expectedEnabled: boolean,
	enabled: boolean,
): void {
	validatePluginId(pluginId);
	const source = readFileSync(configPath, "utf8");
	const parsed = parseToml(source);
	const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
	const plugin = isRecord(plugins[pluginId]) ? plugins[pluginId] : null;
	if (!plugin) throw new Error("The Codex plugin configuration was not found");
	const currentEnabled = plugin.enabled === true;
	if (currentEnabled !== expectedEnabled) {
		throw new Error(
			"The installed plugin status changed. Refresh before changing it.",
		);
	}

	const escapedPluginId = pluginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headerPattern = new RegExp(
		`^\\s*\\[plugins\\."${escapedPluginId}"\\]\\s*(?:#.*)?$`,
		"m",
	);
	const header = headerPattern.exec(source);
	if (!header) {
		throw new Error("The Codex plugin table could not be updated safely");
	}
	const headerEnd = header.index + header[0].length;
	const remaining = source.slice(headerEnd);
	const nextTable = /^\s*\[/m.exec(remaining);
	const sectionEnd =
		nextTable?.index === undefined
			? source.length
			: headerEnd + nextTable.index;
	const section = source.slice(headerEnd, sectionEnd);
	const enabledPattern = /^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?)$/m;
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const updatedSection = enabledPattern.test(section)
		? section.replace(
				enabledPattern,
				(_match, prefix: string, _value: string, suffix: string) =>
					`${prefix}${enabled ? "true" : "false"}${suffix}`,
			)
		: `${newline}enabled = ${enabled ? "true" : "false"}${section}`;
	const updated =
		source.slice(0, headerEnd) + updatedSection + source.slice(sectionEnd);
	const verified = parseToml(updated);
	const verifiedPlugins = isRecord(verified.plugins) ? verified.plugins : {};
	const verifiedPlugin = isRecord(verifiedPlugins[pluginId])
		? verifiedPlugins[pluginId]
		: null;
	if (!verifiedPlugin || (verifiedPlugin.enabled === true) !== enabled) {
		throw new Error("The Codex plugin status update could not be verified");
	}
	writeFileAtomicSync(configPath, updated, {
		mode: statSync(configPath).mode & 0o777,
	});
}

function validateMarketplaceName(name: string): void {
	if (!PLUGIN_PART_RE.test(name)) {
		throw new Error("The provider returned an unsupported marketplace name");
	}
}

function normalizedMarketplaceSource(source: string): string {
	const value = source.trim();
	if (
		!value ||
		value.length > MAX_MARKETPLACE_SOURCE_CHARS ||
		/[\r\n\0]/.test(value)
	) {
		throw new Error("Enter a valid marketplace URL, repository, or local path");
	}
	return value;
}

function normalizedSparsePaths(paths: string[] | undefined): string[] {
	if (!paths) return [];
	if (paths.length > MAX_SPARSE_PATHS) {
		throw new Error(`Use no more than ${MAX_SPARSE_PATHS} sparse paths`);
	}
	return paths.map((path) => {
		const value = path.trim();
		if (
			!value ||
			value.length > MAX_SPARSE_PATH_CHARS ||
			/[\r\n\0]/.test(value)
		) {
			throw new Error(
				"Sparse marketplace paths must be valid single-line paths",
			);
		}
		return value;
	});
}

function validateShellArgument(value: string, label: string): void {
	if (!/^[A-Za-z0-9_./:@+\\ -]+$/.test(value)) {
		throw new Error(
			`${label} contains characters that cannot be passed safely to this provider CLI`,
		);
	}
}

async function locateExtension(
	config: HlidConfig,
	id: string,
	kind: "available" | "installed",
	dependencies: ExtensionMutationDependencies,
): Promise<LocatedExtension | null> {
	const homes = (dependencies.homes ?? providerExtensionHomes)(config);
	const discover = dependencies.discover ?? discoverExtensionInventory;
	for (const home of homes) {
		const inventory = await discover(config, [home]);
		if (kind === "available") {
			const extension = inventory.available.find((item) => item.id === id);
			if (extension) {
				return {
					home,
					providerId: extension.providerId,
					pluginId: extension.pluginId,
					environmentLabel: extension.environmentLabel,
					scope: "user",
					version: extension.version,
					enabled: false,
				};
			}
			continue;
		}
		const extension = inventory.extensions.find((item) => item.id === id);
		if (extension) {
			return {
				home,
				providerId: extension.providerId,
				pluginId: extension.pluginId,
				environmentLabel: extension.environmentLabel,
				scope: extension.scope,
				version: extension.version,
				enabled: extension.enabled,
			};
		}
	}
	return null;
}

async function locateEnvironment(
	config: HlidConfig,
	providerId: ExtensionProviderId,
	environmentId: string,
	dependencies: ExtensionMutationDependencies,
): Promise<ProviderExtensionHome | null> {
	const homes = (dependencies.homes ?? providerExtensionHomes)(config);
	return (
		homes.find(
			(home) => extensionEnvironmentId(providerId, home) === environmentId,
		) ?? null
	);
}

async function locateMarketplace(
	config: HlidConfig,
	id: string,
	dependencies: ExtensionMutationDependencies,
): Promise<LocatedMarketplace | null> {
	const homes = (dependencies.homes ?? providerExtensionHomes)(config);
	const discover = dependencies.discover ?? discoverExtensionInventory;
	for (const home of homes) {
		const inventory = await discover(config, [home]);
		const marketplace = inventory.marketplaces.find((item) => item.id === id);
		if (marketplace) return { home, marketplace };
	}
	return null;
}

function resolveProviderCommand(
	config: HlidConfig,
	home: ProviderExtensionHome,
	providerId: ExtensionProviderId,
	dependencies: ExtensionMutationDependencies,
): Pick<MutationCommand, "executable" | "cwd" | "shell"> {
	const wsl = parseWslUncSyntax(home.path);
	if (wsl) {
		if (!/^[A-Za-z0-9._-]+$/.test(wsl.distro)) {
			throw new Error("The WSL provider environment is invalid");
		}
		const wrapper = (dependencies.writeProviderWrapper ?? writeWrapper)(
			home.path,
			providerId,
		);
		if (!wrapper) {
			throw new Error(
				`Unable to prepare the ${home.environmentLabel} provider command`,
			);
		}
		return { executable: wrapper, shell: true };
	}
	const executable =
		providerId === "claude"
			? (dependencies.resolveClaude ?? resolveClaudeExecutable)()
			: config.codex.executable ||
				(dependencies.resolveCodex ?? resolveCodexExecutable)();
	if (!executable) {
		throw new Error(`${providerId} CLI was not found for this environment`);
	}
	return {
		executable,
		cwd: home.path,
		shell:
			process.platform === "win32" && executable.toLowerCase().endsWith(".cmd"),
	};
}

function commandForMutation(
	config: HlidConfig,
	target: LocatedExtension,
	action: ExtensionMutationInput["action"],
	dependencies: ExtensionMutationDependencies,
): MutationCommand {
	validatePluginId(target.pluginId);
	const scope =
		target.scope === "project" || target.scope === "local"
			? target.scope
			: "user";
	const providerCommand = target.providerId;
	const operation =
		target.providerId === "claude"
			? action === "install"
				? "install"
				: "uninstall"
			: action === "install"
				? "add"
				: "remove";
	const args =
		target.providerId === "claude"
			? [
					"plugin",
					operation,
					target.pluginId,
					"--scope",
					action === "install" ? "user" : scope,
					...(action === "uninstall" ? ["--yes"] : []),
				]
			: ["plugin", operation, target.pluginId, "--json"];
	const displayCommand = `${providerCommand} ${args.join(" ")}`;
	return {
		args,
		displayCommand,
		...resolveProviderCommand(
			config,
			target.home,
			target.providerId,
			dependencies,
		),
	};
}

function failureMessage(
	action: ExtensionMutationInput["action"],
	code: number | null,
	output: string,
): string {
	const detail = output.trim().split(/\r?\n/).slice(-6).join(" ");
	const label =
		action === "install"
			? "Plugin installation"
			: action === "uninstall"
				? "Plugin removal"
				: action === "add_marketplace"
					? "Marketplace addition"
					: action === "upgrade_marketplace"
						? "Marketplace update"
						: "Marketplace removal";
	return detail
		? `${label} exited ${code ?? "without a status"}: ${detail}`
		: `${label} exited ${code ?? "without a status"}`;
}

function isTransientMarketplaceNetworkFailure(output: string): boolean {
	return [
		/connection (?:was )?reset/i,
		/recv failure/i,
		/failed to connect/i,
		/could not resolve host/i,
		/operation timed out/i,
		/tls.*(?:timeout|closed|eof)/i,
		/http\/2 stream.*(?:error|closed)/i,
		/unexpected eof/i,
	].some((pattern) => pattern.test(output));
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolvePromise) =>
		setTimeout(resolvePromise, milliseconds),
	);
}

function marketplaceCommand(
	config: HlidConfig,
	home: ProviderExtensionHome,
	providerId: ExtensionProviderId,
	action:
		| Extract<ExtensionMutationInput, { action: "add_marketplace" }>
		| Extract<ExtensionMutationInput, { action: "upgrade_marketplace" }>
		| Extract<ExtensionMutationInput, { action: "remove_marketplace" }>,
	name: string | null,
	dependencies: ExtensionMutationDependencies,
): MutationCommand {
	const args = ["plugin", "marketplace"];
	const command = resolveProviderCommand(
		config,
		home,
		providerId,
		dependencies,
	);
	if (action.action === "add_marketplace") {
		const source = normalizedMarketplaceSource(action.source);
		const sparse = normalizedSparsePaths(action.sparse);
		const ref = action.ref?.trim() ?? "";
		if (ref && !GIT_REF_RE.test(ref)) {
			throw new Error("The marketplace Git ref is invalid");
		}
		if (command.shell) {
			validateShellArgument(source, "Marketplace source");
			for (const path of sparse) validateShellArgument(path, "Sparse path");
		}
		args.push("add", source);
		if (providerId === "claude") {
			args.push("--scope", "user");
			if (sparse.length > 0) args.push("--sparse", ...sparse);
		} else {
			if (ref) args.push("--ref", ref);
			for (const path of sparse) args.push("--sparse", path);
			args.push("--json");
		}
	} else {
		if (!name) throw new Error("Marketplace source was not found");
		validateMarketplaceName(name);
		if (action.action === "upgrade_marketplace") {
			args.push(providerId === "claude" ? "update" : "upgrade", name);
		} else {
			args.push("remove", name);
		}
		if (providerId === "codex") args.push("--json");
	}
	return {
		args,
		displayCommand: `${providerId} ${args.join(" ")}`,
		...command,
	};
}

export async function mutateProviderExtension(
	config: HlidConfig,
	input: ExtensionMutationInput,
	dependencies: ExtensionMutationDependencies = {},
): Promise<ExtensionMutationResult> {
	if (input.action === "set_enabled") {
		const target = await locateExtension(
			config,
			input.id,
			"installed",
			dependencies,
		);
		if (!target) throw new Error("Installed extension not found");
		if (target.version !== input.expectedVersion) {
			throw new Error(
				"The installed version changed. Refresh before changing this extension.",
			);
		}
		if (target.enabled !== input.expectedEnabled) {
			throw new Error(
				"The installed plugin status changed. Refresh before changing it.",
			);
		}
		if (input.enabled === input.expectedEnabled) {
			throw new Error("The installed plugin already has that status");
		}

		const mutationKey = `${target.providerId}\0${target.home.path}`;
		if (activeMutations.has(mutationKey)) {
			throw new Error(
				`Another ${target.providerId} extension action is already running in ${target.environmentLabel}`,
			);
		}
		activeMutations.add(mutationKey);
		try {
			let output: string;
			if (target.providerId === "claude") {
				validatePluginId(target.pluginId);
				const scope =
					target.scope === "project" || target.scope === "local"
						? target.scope
						: "user";
				const command = resolveProviderCommand(
					config,
					target.home,
					target.providerId,
					dependencies,
				);
				const args = [
					"plugin",
					input.enabled ? "enable" : "disable",
					target.pluginId,
					"--scope",
					scope,
				];
				const result = await (dependencies.run ?? runBoundedProcess)(
					command.executable,
					args,
					{
						timeoutMs: MUTATION_TIMEOUT_MS,
						timeoutError: input.enabled
							? "Plugin enable timed out"
							: "Plugin disable timed out",
						maxOutputChars: MAX_OUTPUT_CHARS,
						shell: command.shell,
						cwd: command.cwd,
					},
				);
				if (result.code !== 0) {
					const detail = result.output
						.trim()
						.split(/\r?\n/)
						.slice(-6)
						.join(" ");
					throw new Error(
						detail
							? `Plugin ${input.enabled ? "enable" : "disable"} exited ${result.code ?? "without a status"}: ${detail}`
							: `Plugin ${input.enabled ? "enable" : "disable"} exited ${result.code ?? "without a status"}`,
					);
				}
				output = result.output.trim();
			} else {
				const configPath = resolve(target.home.path, ".codex", "config.toml");
				(dependencies.setCodexPluginEnabled ?? setCodexPluginEnabled)(
					configPath,
					target.pluginId,
					input.expectedEnabled,
					input.enabled,
				);
				output = `Codex plugin ${input.enabled ? "enabled" : "disabled"}`;
			}

			const refreshed = await (
				dependencies.discover ?? discoverExtensionInventory
			)(config, [target.home]);
			const updated = refreshed.extensions.find(
				(item) => item.id === input.id || item.pluginId === target.pluginId,
			);
			if (!updated || updated.enabled !== input.enabled) {
				throw new Error(
					`The provider action completed, but the plugin is still ${
						input.enabled ? "disabled" : "enabled"
					}`,
				);
			}
			return {
				action: input.action,
				providerId: target.providerId,
				subject: target.pluginId,
				pluginId: target.pluginId,
				environmentLabel: target.environmentLabel,
				output,
			};
		} finally {
			activeMutations.delete(mutationKey);
		}
	}

	if (
		input.action === "add_marketplace" ||
		input.action === "upgrade_marketplace" ||
		input.action === "remove_marketplace"
	) {
		let home: ProviderExtensionHome;
		let providerId: ExtensionProviderId;
		let marketplace: ProviderMarketplace | null = null;
		if (input.action === "add_marketplace") {
			const locatedHome = await locateEnvironment(
				config,
				input.providerId,
				input.environmentId,
				dependencies,
			);
			if (!locatedHome) throw new Error("Provider environment not found");
			home = locatedHome;
			providerId = input.providerId;
		} else {
			const located = await locateMarketplace(config, input.id, dependencies);
			if (!located) throw new Error("Marketplace source not found");
			home = located.home;
			marketplace = located.marketplace;
			providerId = marketplace.providerId;
			if (!marketplace.canManage) {
				throw new Error("This built-in marketplace cannot be changed");
			}
			if (marketplace.source !== input.expectedSource) {
				throw new Error(
					"The marketplace source changed. Refresh before changing it.",
				);
			}
		}

		const mutationKey = `${providerId}\0${home.path}`;
		if (activeMutations.has(mutationKey)) {
			throw new Error(
				`Another ${providerId} extension action is already running in ${home.environmentLabel}`,
			);
		}
		activeMutations.add(mutationKey);
		try {
			const discover = dependencies.discover ?? discoverExtensionInventory;
			const before = await discover(config, [home]);
			const beforeIds = new Set(
				before.marketplaces
					.filter((item) => item.providerId === providerId && item.canManage)
					.map((item) => item.id),
			);
			const command = marketplaceCommand(
				config,
				home,
				providerId,
				input,
				marketplace?.name ?? null,
				dependencies,
			);
			const run = dependencies.run ?? runBoundedProcess;
			const processOptions = {
				timeoutMs: MUTATION_TIMEOUT_MS,
				timeoutError:
					input.action === "add_marketplace"
						? "Marketplace addition timed out"
						: input.action === "upgrade_marketplace"
							? "Marketplace update timed out"
							: "Marketplace removal timed out",
				maxOutputChars: MAX_OUTPUT_CHARS,
				shell: command.shell,
				cwd: command.cwd,
			};
			let result = await run(command.executable, command.args, processOptions);
			let retriedTransientFailure = false;
			if (
				input.action === "upgrade_marketplace" &&
				result.code !== 0 &&
				isTransientMarketplaceNetworkFailure(result.output)
			) {
				retriedTransientFailure = true;
				await (dependencies.wait ?? wait)(MARKETPLACE_UPDATE_RETRY_DELAY_MS);
				result = await run(command.executable, command.args, processOptions);
			}
			if (result.code !== 0) {
				const message = failureMessage(
					input.action,
					result.code,
					result.output,
				);
				throw new Error(
					retriedTransientFailure
						? `${message} Hlið retried once after a transient network failure.`
						: message,
				);
			}

			const refreshed = await discover(config, [home]);
			const providerMarketplaces = refreshed.marketplaces.filter(
				(item) => item.providerId === providerId,
			);
			const refreshedMarketplace = marketplace
				? providerMarketplaces.find(
						(item) => item.id === marketplace.id && item.canManage,
					)
				: providerMarketplaces.find(
						(item) => item.canManage && !beforeIds.has(item.id),
					);
			if (
				(input.action === "add_marketplace" && !refreshedMarketplace) ||
				(input.action === "upgrade_marketplace" && !refreshedMarketplace) ||
				(input.action === "remove_marketplace" && refreshedMarketplace)
			) {
				throw new Error(
					input.action === "add_marketplace"
						? "The provider command completed, but no marketplace was added"
						: input.action === "upgrade_marketplace"
							? "The provider command completed, but the marketplace disappeared"
							: "The provider command completed, but the marketplace is still configured",
				);
			}
			const subject =
				marketplace?.name ??
				refreshedMarketplace?.name ??
				(input.action === "add_marketplace"
					? normalizedMarketplaceSource(input.source)
					: "Marketplace");
			return {
				action: input.action,
				providerId,
				subject,
				environmentLabel: home.environmentLabel,
				output: result.output.trim(),
			};
		} finally {
			activeMutations.delete(mutationKey);
		}
	}

	const kind = input.action === "install" ? "available" : "installed";
	const target = await locateExtension(config, input.id, kind, dependencies);
	if (!target) {
		throw new Error(
			input.action === "install"
				? "Marketplace extension not found"
				: "Installed extension not found",
		);
	}

	const mutationKey = `${target.providerId}\0${target.home.path}`;
	if (activeMutations.has(mutationKey)) {
		throw new Error(
			`Another ${target.providerId} extension action is already running in ${target.environmentLabel}`,
		);
	}
	activeMutations.add(mutationKey);
	try {
		if (input.action === "install") {
			const current = await (
				dependencies.discover ?? discoverExtensionInventory
			)(config, [target.home]);
			if (
				current.extensions.some(
					(item) =>
						item.providerId === target.providerId &&
						item.pluginId === target.pluginId,
				)
			) {
				throw new Error("This extension is already installed");
			}
			const review = await (dependencies.review ?? reviewAvailableExtension)(
				config,
				input.id,
				[target.home],
			);
			if (!review) throw new Error("Extension review was not found");
			if (review.reviewToken !== input.reviewToken) {
				throw new Error(
					"The cached package changed after review. Review it again before installing.",
				);
			}
		} else if (target.version !== input.expectedVersion) {
			throw new Error(
				"The installed version changed. Refresh before removing this extension.",
			);
		}

		const command = commandForMutation(
			config,
			target,
			input.action,
			dependencies,
		);
		const result = await (dependencies.run ?? runBoundedProcess)(
			command.executable,
			command.args,
			{
				timeoutMs: MUTATION_TIMEOUT_MS,
				timeoutError:
					input.action === "install"
						? "Plugin installation timed out"
						: "Plugin removal timed out",
				maxOutputChars: MAX_OUTPUT_CHARS,
				shell: command.shell,
				cwd: command.cwd,
			},
		);
		if (result.code !== 0) {
			throw new Error(failureMessage(input.action, result.code, result.output));
		}

		const refreshed = await (
			dependencies.discover ?? discoverExtensionInventory
		)(config, [target.home]);
		const stillInstalled = refreshed.extensions.some(
			(item) => item.id === input.id || item.pluginId === target.pluginId,
		);
		if (input.action === "install" ? !stillInstalled : stillInstalled) {
			throw new Error(
				input.action === "install"
					? "The provider command completed, but the extension was not installed"
					: "The provider command completed, but the extension is still installed",
			);
		}

		return {
			action: input.action,
			providerId: target.providerId,
			subject: target.pluginId,
			pluginId: target.pluginId,
			environmentLabel: target.environmentLabel,
			output: result.output.trim(),
		};
	} finally {
		activeMutations.delete(mutationKey);
	}
}
