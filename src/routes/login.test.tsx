// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => options,
	useNavigate: () => vi.fn(),
}));

const { LoginPage } = await import("./login");

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ state: "setup-required", theme: "dark" }),
		),
	);
	vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
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
});
