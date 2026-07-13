// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerForm } from "./NetworkSection";
import { TailscaleFields, type TailscaleStatus } from "./TailscaleFields";

afterEach(cleanup);

function makeServer(overrides?: Partial<ServerForm>): ServerForm {
	return {
		port: "3000",
		tlsCertPath: "",
		tlsKeyPath: "",
		tlsProxyPort: "",
		localNetworkAccess: false,
		allowExternalAgents: false,
		...overrides,
	};
}

function makeStatus(overrides?: Partial<TailscaleStatus>): TailscaleStatus {
	return {
		installed: true,
		state: "Running",
		magicDNS: null,
		ips: [],
		...overrides,
	};
}

function renderFields(
	status: TailscaleStatus | null,
	server: ServerForm = makeServer(),
	extra?: Partial<{
		checking: boolean;
		onChange: (patch: Partial<ServerForm>) => void;
		onRefresh: () => void;
		onStartSetup: () => void;
	}>,
) {
	return render(
		<TailscaleFields
			server={server}
			onChange={extra?.onChange ?? (() => {})}
			status={status}
			checking={extra?.checking ?? false}
			onRefresh={extra?.onRefresh ?? (() => {})}
			onStartSetup={extra?.onStartSetup ?? (() => {})}
		/>,
	);
}

describe("TailscaleFields", () => {
	it("shows checking state while status is null", () => {
		renderFields(null);
		expect(screen.getByText("checking…")).toBeTruthy();
		expect(screen.queryByText("Authenticated")).toBeNull();
	});

	it("shows download button when not installed and opens download page", () => {
		const open = vi.fn();
		vi.stubGlobal("open", open);
		renderFields(makeStatus({ installed: false, state: null }));
		expect(screen.getByText("not detected")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "DOWNLOAD" }));
		expect(open).toHaveBeenCalledWith(
			"https://tailscale.com/download",
			"_blank",
			"noopener,noreferrer",
		);
		vi.unstubAllGlobals();
	});

	it("shows authenticated yes when running", () => {
		renderFields(makeStatus());
		expect(screen.getByText("Authenticated")).toBeTruthy();
		// "yes" renders for both Installed and Authenticated
		expect(screen.getAllByText("yes")).toHaveLength(2);
	});

	it("hints login command when NeedsLogin", () => {
		renderFields(makeStatus({ state: "NeedsLogin" }));
		expect(screen.getByText("run `tailscale up` to log in")).toBeTruthy();
		expect(screen.getByText("no")).toBeTruthy();
	});

	it("hints raw state when stopped", () => {
		renderFields(makeStatus({ state: "Stopped" }));
		expect(screen.getByText("state: Stopped")).toBeTruthy();
	});

	it("renders MagicDNS name when present", () => {
		renderFields(makeStatus({ magicDNS: "host.tail1234.ts.net" }));
		expect(screen.getByText("MagicDNS")).toBeTruthy();
		expect(screen.getByText("host.tail1234.ts.net")).toBeTruthy();
	});

	it("shows tailnet URL only when running with TLS config and LAN access", () => {
		const server = makeServer({
			tlsCertPath: "/certs/cert.pem",
			tlsKeyPath: "/certs/key.pem",
			localNetworkAccess: true,
		});
		renderFields(makeStatus({ magicDNS: "host.tail1234.ts.net" }), server);
		expect(screen.getByText("https://host.tail1234.ts.net:3443")).toBeTruthy();
	});

	it("uses configured TLS proxy port in URL", () => {
		const server = makeServer({
			tlsCertPath: "/certs/cert.pem",
			tlsKeyPath: "/certs/key.pem",
			localNetworkAccess: true,
			tlsProxyPort: "8443",
		});
		renderFields(makeStatus({ magicDNS: "host.tail1234.ts.net" }), server);
		expect(screen.getByText("https://host.tail1234.ts.net:8443")).toBeTruthy();
	});

	it("hides URL when TLS paths missing", () => {
		renderFields(
			makeStatus({ magicDNS: "host.tail1234.ts.net" }),
			makeServer({ localNetworkAccess: true }),
		);
		expect(screen.queryByText(/^https:\/\//)).toBeNull();
	});

	it("RECHECK triggers refresh and disables while checking", () => {
		const onRefresh = vi.fn();
		renderFields(makeStatus(), makeServer(), { onRefresh });
		fireEvent.click(screen.getByRole("button", { name: "RECHECK" }));
		expect(onRefresh).toHaveBeenCalledOnce();
		cleanup();
		renderFields(makeStatus(), makeServer(), { checking: true });
		expect(
			(screen.getByRole("button", { name: "…" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("START triggers setup guide", () => {
		const onStartSetup = vi.fn();
		renderFields(makeStatus(), makeServer(), { onStartSetup });
		fireEvent.click(screen.getByRole("button", { name: "START" }));
		expect(onStartSetup).toHaveBeenCalledOnce();
	});

	it("renders status error", () => {
		renderFields(makeStatus({ error: "tailscale CLI crashed" }));
		expect(screen.getByText("tailscale CLI crashed")).toBeTruthy();
	});
});
