// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UmbodSnapshot } from "#/components/forge/UmbodSection";
import type { HlidConfig } from "#/config";
import { UmbodManifestPanel } from "./UmbodManifestPanel";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const value = {
	enabled: true,
	manifest_path: "/vault/umbod.toml",
} as HlidConfig["umbod"];

function renderPanel(
	snapshot: UmbodSnapshot | null = null,
	overrides?: Partial<{
		onChange: (next: HlidConfig["umbod"]) => void;
		onSaved: () => Promise<void>;
	}>,
) {
	const props = {
		value,
		onChange: overrides?.onChange ?? vi.fn(),
		snapshot,
		onSaved: overrides?.onSaved ?? vi.fn().mockResolvedValue(undefined),
	};
	render(<UmbodManifestPanel {...props} />);
	return props;
}

describe("UmbodManifestPanel", () => {
	it("toggles enabled and edits the manifest path", () => {
		const onChange = vi.fn();
		renderPanel(null, { onChange });
		fireEvent.click(screen.getByRole("checkbox"));
		expect(onChange).toHaveBeenCalledWith({ ...value, enabled: false });
		fireEvent.change(screen.getByDisplayValue("/vault/umbod.toml"), {
			target: { value: "/vault/policy.toml" },
		});
		expect(onChange).toHaveBeenCalledWith({
			...value,
			manifest_path: "/vault/policy.toml",
		});
	});

	it("seeds the editor from the snapshot source", () => {
		renderPanel({ source: "[tools]\nallow = true" } as UmbodSnapshot);
		expect(
			(screen.getByLabelText("Umbod manifest TOML") as HTMLTextAreaElement)
				.value,
		).toBe("[tools]\nallow = true");
	});

	it("saves the manifest and reloads insights on success", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const onSaved = vi.fn().mockResolvedValue(undefined);
		renderPanel(null, { onSaved });
		fireEvent.change(screen.getByLabelText("Umbod manifest TOML"), {
			target: { value: "[rules]" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
		expect(await screen.findByText("Manifest saved")).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/umbod",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ source: "[rules]" }),
			}),
		);
		expect(onSaved).toHaveBeenCalledOnce();
	});

	it("surfaces validation errors without reloading", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				json: async () => ({ error: "invalid TOML at line 3" }),
			})),
		);
		const onSaved = vi.fn().mockResolvedValue(undefined);
		renderPanel(null, { onSaved });
		fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
		expect(await screen.findByText("invalid TOML at line 3")).toBeTruthy();
		expect(onSaved).not.toHaveBeenCalled();
	});

	it("shows tool totals and non-active rule findings from the snapshot", () => {
		renderPanel({
			enabled: true,
			tools: { totals: { entries: 42 } },
			rules: {
				rules: [
					{ status: "active" },
					{ status: "stale" },
					{ status: "unused" },
				],
				tomlSnippet: "[suggested]\nblock = ['rm']",
			},
		} as UmbodSnapshot);
		expect(screen.getByText("42")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
		expect(screen.getByText(/block = \['rm'\]/)).toBeTruthy();
	});
});
