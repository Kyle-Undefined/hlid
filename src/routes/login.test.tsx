// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enterAuthenticatedApp: vi.fn() }));

vi.mock("#/lib/authClient", () => ({
	enterAuthenticatedApp: mocks.enterAuthenticatedApp,
}));

const { LoginPage } = await import("./-LoginPage");

beforeEach(() => {
	mocks.enterAuthenticatedApp.mockReset();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ state: "setup-required", theme: "dark" }),
		),
	);
	vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("first-run password setup", () => {
	it("shows the complete password requirements and associates them with the field", async () => {
		render(<LoginPage />);

		await screen.findByRole("heading", { name: "Create app password" });
		const password = screen.getByLabelText("Password");
		const requirements = screen.getByText(
			"Use 12 to 256 characters. There are no uppercase, number, or symbol requirements.",
		);
		expect(password.getAttribute("minlength")).toBe("12");
		expect(password.getAttribute("maxlength")).toBe("256");
		expect(password.getAttribute("aria-describedby")).toBe(requirements.id);
		expect(password.hasAttribute("required")).toBe(true);
		expect(
			screen.getByLabelText("Confirm password").hasAttribute("required"),
		).toBe(true);
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
	});

	it("rejects mismatched passwords without sending setup credentials", async () => {
		render(<LoginPage />);
		await screen.findByRole("heading", { name: "Create app password" });
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "long-enough-password" },
		});
		fireEvent.change(screen.getByLabelText("Confirm password"), {
			target: { value: "different-password" },
		});
		const button = screen.getByRole("button", { name: "Set password" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.submit(button.closest("form") as HTMLFormElement);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Passwords do not match",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("enables setup only after the confirmation exactly matches", async () => {
		render(<LoginPage />);
		await screen.findByRole("heading", { name: "Create app password" });
		const button = screen.getByRole("button", { name: "Set password" });
		const password = screen.getByLabelText("Password");
		const confirm = screen.getByLabelText("Confirm password");

		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(password, { target: { value: "long-enough-password" } });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(confirm, { target: { value: "different-password" } });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(confirm, { target: { value: "long-enough-password" } });
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});
});

describe("existing password login", () => {
	it("shows an API error and allows another attempt", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({ state: "unauthenticated", theme: "dark" }),
				)
				.mockResolvedValueOnce(
					Response.json({ error: "Invalid password" }, { status: 401 }),
				),
		);
		render(<LoginPage />);
		await screen.findByRole("heading", { name: "Unlock Hlid" });
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "long-enough-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Invalid password",
		);
		expect(
			(screen.getByRole("button", { name: "Unlock" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect(mocks.enterAuthenticatedApp).not.toHaveBeenCalled();
	});

	it("re-enters the app with a document navigation after unlocking", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({ state: "unauthenticated", theme: "dark" }),
				)
				.mockResolvedValueOnce(Response.json({ ok: true })),
		);
		render(<LoginPage />);
		await screen.findByRole("heading", { name: "Unlock Hlid" });
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "long-enough-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

		await waitFor(() =>
			expect(mocks.enterAuthenticatedApp).toHaveBeenCalledTimes(1),
		);
	});

	it("reports status lookup failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("down", { status: 503 })),
		);
		render(<LoginPage />);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Unable to check authentication",
		);
	});
});
