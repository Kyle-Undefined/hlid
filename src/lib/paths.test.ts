import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
	APP_DIR,
	CONFIG_PATH,
	canonical,
	expandTilde,
	isPathAccessibleFromRuntime,
	LIBRARY_DIR,
	PRICING_OVERRIDES_PATH,
	parseWslUnc,
	pathStartsWith,
	samePath,
	toLogical,
	toProviderRuntimePath,
} from "./paths";

// ── CONFIG_PATH ───────────────────────────────────────────────────────────────

describe("CONFIG_PATH", () => {
	it("resolves to hlid.config.toml inside APP_DIR", () => {
		expect(CONFIG_PATH).toBe(resolve(APP_DIR, "hlid.config.toml"));
	});
});

describe("PRICING_OVERRIDES_PATH", () => {
	it("resolves to pricing-overrides.toml inside APP_DIR", () => {
		expect(PRICING_OVERRIDES_PATH).toBe(
			resolve(APP_DIR, "pricing-overrides.toml"),
		);
	});
});

describe("LIBRARY_DIR", () => {
	it("uses isolated storage in tests and APP_DIR in production", () => {
		expect(LIBRARY_DIR).toBe(
			process.env.NODE_ENV === "test"
				? resolve(tmpdir(), "hlid-test-library")
				: resolve(APP_DIR, "library"),
		);
	});
});

// ── expandTilde ───────────────────────────────────────────────────────────────

describe("expandTilde", () => {
	it("returns bare ~ as homedir", () => {
		expect(expandTilde("~")).toBe(homedir());
	});

	it("expands ~/foo to homedir/foo", () => {
		expect(expandTilde("~/foo/bar")).toBe(resolve(homedir(), "foo/bar"));
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandTilde("/absolute/path")).toBe("/absolute/path");
	});

	it("leaves relative paths unchanged", () => {
		expect(expandTilde("relative/path")).toBe("relative/path");
	});

	it("leaves paths with ~ in middle unchanged", () => {
		expect(expandTilde("/foo/~bar")).toBe("/foo/~bar");
	});
});

// ── canonical / samePath ──────────────────────────────────────────────────────

describe("canonical", () => {
	it("resolves relative path to absolute", () => {
		const result = canonical("foo/bar");
		expect(result.startsWith("/")).toBe(true);
	});

	it("resolves . and .. segments", () => {
		expect(canonical("/foo/bar/../baz")).toBe("/foo/baz");
	});
});

describe("samePath", () => {
	it("returns true for identical paths", () => {
		expect(samePath("/foo/bar", "/foo/bar")).toBe(true);
	});

	it("returns true when paths resolve to the same absolute path", () => {
		expect(samePath("/foo/bar/../bar", "/foo/bar")).toBe(true);
	});

	it("returns false for different paths", () => {
		expect(samePath("/foo/bar", "/foo/baz")).toBe(false);
	});

	it("returns false when one is a prefix of the other", () => {
		expect(samePath("/foo/bar", "/foo/barbaz")).toBe(false);
	});
});

// ── pathStartsWith ────────────────────────────────────────────────────────────

describe("pathStartsWith", () => {
	it("returns true for exact match", () => {
		expect(pathStartsWith("/foo/bar", "/foo/bar")).toBe(true);
	});

	it("returns true for direct child", () => {
		expect(pathStartsWith("/foo/bar", "/foo/bar/baz")).toBe(true);
	});

	it("returns true for deeply nested child", () => {
		expect(pathStartsWith("/foo", "/foo/bar/baz/qux")).toBe(true);
	});

	it("returns false for sibling path sharing common prefix chars", () => {
		// /foo/bar should NOT contain /foo/barbaz
		expect(pathStartsWith("/foo/bar", "/foo/barbaz")).toBe(false);
	});

	it("returns false when child is actually a parent", () => {
		expect(pathStartsWith("/foo/bar/baz", "/foo/bar")).toBe(false);
	});

	it("handles parent with trailing separator", () => {
		expect(pathStartsWith(`/foo/bar${sep}`, "/foo/bar/child")).toBe(true);
	});

	it("returns false for completely unrelated paths", () => {
		expect(pathStartsWith("/alpha", "/beta/gamma")).toBe(false);
	});
});

// ── parseWslUnc ───────────────────────────────────────────────────────────────

describe("parseWslUnc", () => {
	it("returns null on non-Windows (Linux/macOS)", () => {
		// process.platform is 'linux' in CI — parseWslUnc always returns null
		if (process.platform !== "win32") {
			expect(parseWslUnc("\\\\wsl$\\Ubuntu\\home\\kyle")).toBeNull();
		}
	});
});

// ── toLogical ─────────────────────────────────────────────────────────────────

describe("toLogical", () => {
	it("returns POSIX path unchanged on Linux/macOS", () => {
		expect(toLogical("/home/kyle/project")).toBe("/home/kyle/project");
	});

	it("returns Windows-native path unchanged on Linux/macOS", () => {
		// On non-Windows parseWslUnc returns null, so path passes through
		if (process.platform !== "win32") {
			expect(toLogical("C:\\Users\\kyle")).toBe("C:\\Users\\kyle");
		}
	});
});

// ── toProviderRuntimePath ────────────────────────────────────────────────────

describe("toProviderRuntimePath", () => {
	const wslRuntime =
		"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\seidr";

	it("maps a Windows drive root into the WSL mount namespace", () => {
		expect(
			toProviderRuntimePath(
				wslRuntime,
				"C:\\Users\\kyleu\\Documents\\Obsidian\\Fornbok",
			),
		).toBe("/mnt/c/Users/kyleu/Documents/Obsidian/Fornbok");
	});

	it("maps WSL UNC roots to their POSIX paths", () => {
		expect(
			toProviderRuntimePath(
				wslRuntime,
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\shared",
			),
		).toBe("/home/kyle/shared");
	});

	it("does not translate a UNC path owned by another distro", () => {
		const other = "\\\\wsl.localhost\\Debian\\home\\kyle\\shared";
		expect(toProviderRuntimePath(wslRuntime, other)).toBe(other);
		expect(isPathAccessibleFromRuntime(wslRuntime, other)).toBe(false);
	});

	it("allows Windows drive resources and same-distro UNC paths", () => {
		expect(
			isPathAccessibleFromRuntime(wslRuntime, "C:\\Users\\kyle\\file"),
		).toBe(true);
		expect(
			isPathAccessibleFromRuntime(
				wslRuntime,
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\file",
			),
		).toBe(true);
	});

	it("keeps host paths unchanged for native runtimes", () => {
		const path = "C:\\Users\\kyleu\\project";
		expect(toProviderRuntimePath("C:\\Users\\kyleu\\project", path)).toBe(path);
		expect(toProviderRuntimePath("/home/kyle/project", path)).toBe(path);
	});
});
