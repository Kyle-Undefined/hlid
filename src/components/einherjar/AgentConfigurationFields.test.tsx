// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "#/lib/providerTypes";
import {
	AgentConfigurationFields,
	type AgentConfigurationValue,
} from "./AgentConfigurationFields";

afterEach(cleanup);

const value: AgentConfigurationValue = {
	mode: "context",
	provider: "claude",
	model: "sonnet",
	effort: "high",
	maxTurns: "10",
	permissionMode: "default",
	recapModel: "haiku",
	interactiveMode: true,
};

const provider: ProviderInfo = {
	id: "claude",
	label: "Claude",
	available: false,
	unavailableReason: "CLI missing",
	models: [
		{ value: "sonnet", label: "Sonnet" },
		{ value: "haiku", label: "Haiku" },
	],
	effortLevels: [
		{ value: "low", label: "Low" },
		{ value: "high", label: "High" },
	],
	permissionModes: [{ value: "default", label: "Default" }],
};

describe("AgentConfigurationFields", () => {
	it("renders provider capabilities and emits each setting change", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<AgentConfigurationFields
				value={value}
				providers={[provider]}
				onChange={onChange}
				includeInteractive
			/>,
		);

		expect(screen.getByText("CLI missing")).not.toBeNull();
		expect(
			screen.getByText(
				"stays in vault, loads AGENTS.md or CLAUDE.md as persona",
			),
		).not.toBeNull();
		expect(screen.queryByText(/claude stays/i)).toBeNull();
		fireEvent.click(screen.getByText("CWD"));
		rerender(
			<AgentConfigurationFields
				value={{ ...value, mode: "cwd" }}
				providers={[provider]}
				onChange={onChange}
				includeInteractive
			/>,
		);
		expect(screen.getByText("runs in agent's directory")).not.toBeNull();
		expect(screen.queryByText(/claude runs/i)).toBeNull();
		const selects = screen.getAllByRole("combobox");
		fireEvent.change(selects[0], { target: { value: "haiku" } });
		fireEvent.change(selects[1], { target: { value: "low" } });
		fireEvent.change(selects[2], { target: { value: "" } });
		fireEvent.change(screen.getByRole("spinbutton"), {
			target: { value: "0" },
		});
		fireEvent.change(selects[3], { target: { value: "sonnet" } });
		fireEvent.click(screen.getByRole("checkbox"));

		expect(onChange).toHaveBeenCalledWith({ mode: "cwd" });
		expect(onChange).toHaveBeenCalledWith({ model: "haiku", effort: "high" });
		expect(onChange).toHaveBeenCalledWith({ effort: "low" });
		expect(onChange).toHaveBeenCalledWith({ permissionMode: "" });
		expect(onChange).toHaveBeenCalledWith({ maxTurns: "1" });
		expect(onChange).toHaveBeenCalledWith({ recapModel: "sonnet" });
		expect(onChange).toHaveBeenCalledWith({ interactiveMode: false });
	});

	it("supports an empty provider catalog and clears invalid input", () => {
		const onChange = vi.fn();
		render(
			<AgentConfigurationFields
				value={{ ...value, provider: "unknown", model: "", effort: "" }}
				providers={[]}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByText("CONTEXT"));
		expect(screen.queryByText("Provider")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(onChange).toHaveBeenCalledWith({ mode: "context" });
	});
});
