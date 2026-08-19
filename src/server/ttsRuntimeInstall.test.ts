import { describe, expect, it, vi } from "vitest";
import {
	downloadAndInstallQualifiedTtsRuntime,
	ttsRuntimeReleaseUrls,
} from "./ttsRuntimeInstall";

const runtimeId = "sherpa-tts-1.13.4-ort-dml-1.24.4-directml-1.15.4-r2-win-x64";

describe("DirectML runtime release installation", () => {
	it("resolves the exact runtime pair from the matching Hlid release", () => {
		expect(ttsRuntimeReleaseUrls("0.1.92")).toEqual({
			archive: `https://github.com/Kyle-Undefined/hlid/releases/download/v0.1.92/${runtimeId}.zip`,
			manifest:
				"https://github.com/Kyle-Undefined/hlid/releases/download/v0.1.92/runtime-manifest.json",
		});
		expect(() => ttsRuntimeReleaseUrls("latest/unsafe")).toThrow(
			"release version is invalid",
		);
	});

	it("downloads bounded manifest and archive bytes before using the reviewed installer", async () => {
		const manifest = new TextEncoder().encode("manifest");
		const archive = new TextEncoder().encode("archive");
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			const body = url.endsWith("runtime-manifest.json") ? manifest : archive;
			return new Response(body, {
				headers: { "content-length": String(body.byteLength) },
			});
		});
		const fetcher = fetchMock as unknown as typeof fetch;
		const assets = {
			directory: "C:/Local/hlid/tts/runtime",
			addonPath: "C:/Local/hlid/tts/runtime/sherpa-onnx.node",
			backends: ["directml" as const],
		};
		const installer = vi.fn(async () => assets);

		await expect(
			downloadAndInstallQualifiedTtsRuntime({
				version: "0.1.92",
				platform: "win32",
				architecture: "x64",
				directory: assets.directory,
				fetcher,
				installer,
			}),
		).resolves.toEqual(assets);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://github.com/Kyle-Undefined/hlid/releases/download/v0.1.92/runtime-manifest.json",
			`https://github.com/Kyle-Undefined/hlid/releases/download/v0.1.92/${runtimeId}.zip`,
		]);
		expect(installer).toHaveBeenCalledWith(archive, manifest, {
			platform: "win32",
			architecture: "x64",
			directory: assets.directory,
		});
	});

	it("rejects unsupported hosts and oversized release responses before installation", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("oversized", {
					headers: { "content-length": String(256 * 1024 + 1) },
				}),
		) as unknown as typeof fetch;
		const installer = vi.fn();

		await expect(
			downloadAndInstallQualifiedTtsRuntime({
				platform: "linux",
				architecture: "x64",
				fetcher,
				installer,
			}),
		).rejects.toThrow("requires Windows x64");
		expect(fetcher).not.toHaveBeenCalled();

		await expect(
			downloadAndInstallQualifiedTtsRuntime({
				version: "0.1.92",
				platform: "win32",
				architecture: "x64",
				fetcher,
				installer,
			}),
		).rejects.toThrow("manifest has an invalid download size");
		expect(installer).not.toHaveBeenCalled();
	});
});
