import { describe, expect, it } from "vitest";
import { ASK_USER_QUESTION_CANCEL_KEY } from "./protocol";
import {
	parseProviderElicitationFields,
	providerElicitationContent,
	providerElicitationDecisionAnswers,
	providerElicitationQuestions,
	providerElicitationSelectedAnswer,
	providerElicitationWasCancelled,
	safeProviderElicitationUrl,
} from "./providerElicitation";

function fieldsFor(property: Record<string, unknown>) {
	const fields = parseProviderElicitationFields({
		type: "object",
		properties: { value: property },
		required: ["value"],
	});
	expect(fields).not.toBeNull();
	return fields ?? [];
}

describe("provider elicitation", () => {
	it("parses the standard primitive schemas and preserves native labels", () => {
		const fields = parseProviderElicitationFields({
			type: "object",
			required: ["mode", "region", "scopes", "enabled", "retries"],
			properties: {
				mode: {
					type: "string",
					title: "Mode",
					description: "Connection mode",
					enum: ["fast", "safe"],
					enumNames: ["Fast mode", "Safe mode"],
				},
				region: {
					type: "string",
					title: "Region",
					oneOf: [
						{ const: "us", title: "United States" },
						{ const: "eu", title: "Europe" },
					],
				},
				scopes: {
					type: "array",
					title: "Scopes",
					minItems: 1,
					maxItems: 2,
					items: {
						anyOf: [
							{ const: "read", title: "Read" },
							{ const: "write", title: "Write" },
						],
					},
				},
				enabled: { type: "boolean", title: "Enabled" },
				retries: {
					type: "integer",
					title: "Retries",
					minimum: 1,
					maximum: 5,
				},
			},
		});

		expect(fields).not.toBeNull();
		expect(fields?.map((field) => [field.key, [...field.values]])).toEqual([
			[
				"mode",
				[
					["Fast mode", "fast"],
					["Safe mode", "safe"],
				],
			],
			[
				"region",
				[
					["United States", "us"],
					["Europe", "eu"],
				],
			],
			[
				"scopes",
				[
					["Read", "read"],
					["Write", "write"],
				],
			],
			[
				"enabled",
				[
					["Yes", true],
					["No", false],
				],
			],
			["retries", []],
		]);
		expect(providerElicitationQuestions(fields ?? [])).toEqual([
			{
				question: "Mode",
				options: ["Fast mode", "Safe mode"],
				multiSelect: false,
				placeholder: "Connection mode",
			},
			{
				question: "Region",
				options: ["United States", "Europe"],
				multiSelect: false,
			},
			{
				question: "Scopes",
				options: ["Read", "Write"],
				multiSelect: true,
			},
			{
				question: "Enabled",
				options: ["Yes", "No"],
				multiSelect: false,
			},
			{
				question: "Retries",
				options: [],
				multiSelect: false,
				freeText: true,
				inputType: "number",
			},
		]);
	});

	it("returns fully typed content after validating every standard constraint", () => {
		const fields = parseProviderElicitationFields({
			type: "object",
			required: [
				"label",
				"email",
				"uri",
				"date",
				"dateTime",
				"count",
				"ratio",
				"scopes",
			],
			properties: {
				label: { type: "string", minLength: 3, maxLength: 20 },
				email: { type: "string", format: "email" },
				uri: { type: "string", format: "uri" },
				date: { type: "string", format: "date" },
				dateTime: { type: "string", format: "date-time" },
				count: { type: "integer", minimum: 1, maximum: 5 },
				ratio: { type: "number", minimum: -1, maximum: 1 },
				scopes: {
					type: "array",
					minItems: 1,
					maxItems: 2,
					items: { type: "string", enum: ["read", "write"] },
				},
			},
		});
		expect(fields).not.toBeNull();

		expect(
			providerElicitationContent(fields ?? [], {
				label: "hello, world",
				email: "raven@example.test",
				uri: "urn:hlid:raven",
				date: "2024-02-29",
				dateTime: "2026-08-09T12:30:45-04:00",
				count: "3",
				ratio: "-0.5",
				scopes: "read, write",
			}),
		).toEqual({
			label: "hello, world",
			email: "raven@example.test",
			uri: "urn:hlid:raven",
			date: "2024-02-29",
			dateTime: "2026-08-09T12:30:45-04:00",
			count: 3,
			ratio: -0.5,
			scopes: ["read", "write"],
		});
	});

	it.each([
		["minimum string length", { type: "string", minLength: 3 }, "hi"],
		["maximum string length", { type: "string", maxLength: 3 }, "four"],
		["email format", { type: "string", format: "email" }, "not-an-email"],
		["URI format", { type: "string", format: "uri" }, "relative/path"],
		["date format", { type: "string", format: "date" }, "2023-02-29"],
		[
			"date-time format",
			{ type: "string", format: "date-time" },
			"2026-08-09 12:30:45",
		],
		["number minimum", { type: "number", minimum: 2 }, "1.5"],
		["number maximum", { type: "number", maximum: 2 }, "2.5"],
		["integer type", { type: "integer" }, "1.5"],
	])("rejects an answer that violates %s", (_label, property, answer) => {
		expect(
			providerElicitationContent(fieldsFor(property), { value: answer }),
		).toBe(null);
	});

	it("enforces array item bounds and titled values", () => {
		const fields = fieldsFor({
			type: "array",
			minItems: 2,
			maxItems: 2,
			items: {
				anyOf: [
					{ const: "read", title: "Read" },
					{ const: "write", title: "Write" },
					{ const: "admin", title: "Admin" },
				],
			},
		});
		expect(providerElicitationContent(fields, { value: "Read" })).toBeNull();
		expect(
			providerElicitationContent(fields, { value: "Read, Write, Admin" }),
		).toBeNull();
		expect(
			providerElicitationContent(fields, { value: "Read, Write" }),
		).toEqual({ value: ["read", "write"] });
	});

	it("preserves comma-containing free text and rejects ambiguous numeric text", () => {
		expect(
			providerElicitationContent(fieldsFor({ type: "string" }), {
				value: "hello, world",
			}),
		).toEqual({ value: "hello, world" });
		expect(
			providerElicitationContent(fieldsFor({ type: "number" }), {
				value: "1, 2",
			}),
		).toBeNull();
		expect(providerElicitationSelectedAnswer("One, Two\n\nNotes: later")).toBe(
			"One, Two",
		);
	});

	it("fails closed for unknown enum labels and malformed schemas", () => {
		const fields = fieldsFor({
			type: "string",
			enum: ["safe"],
			enumNames: ["Safe mode"],
		});
		expect(
			providerElicitationContent(fields, { value: "Future mode" }),
		).toBeNull();
		expect(
			parseProviderElicitationFields({
				properties: { value: { type: "string" } },
				required: ["value"],
			}),
		).not.toBeNull();

		for (const schema of [
			null,
			{},
			{ type: "array", properties: {} },
			{ type: "object", properties: {}, required: "value" },
			{
				type: "object",
				properties: { value: { type: "object" } },
			},
			{
				type: "object",
				properties: {
					value: {
						type: "string",
						enum: ["one", "two"],
						enumNames: ["One"],
					},
				},
			},
			{
				type: "object",
				properties: {
					value: { type: "string", minLength: 4, maxLength: 2 },
				},
			},
			{
				type: "object",
				properties: {
					value: { type: "array", minItems: 2, maxItems: 1, items: {} },
				},
			},
		]) {
			expect(parseProviderElicitationFields(schema)).toBeNull();
		}
	});

	it("accepts only normalized HTTP(S) browser URLs", () => {
		expect(safeProviderElicitationUrl("https://example.test/oauth")).toBe(
			"https://example.test/oauth",
		);
		expect(safeProviderElicitationUrl("http://example.test")).toBe(
			"http://example.test/",
		);
		expect(safeProviderElicitationUrl("javascript:alert(1)")).toBeNull();
		expect(safeProviderElicitationUrl("file:///tmp/token")).toBeNull();
		expect(safeProviderElicitationUrl("not a URL")).toBeNull();
	});

	it("extracts allow answers and recognizes shared cancellation", () => {
		const answers = providerElicitationDecisionAnswers({
			behavior: "allow",
			updatedInput: {
				answers: { [ASK_USER_QUESTION_CANCEL_KEY]: "" },
			},
		});
		expect(providerElicitationWasCancelled(answers)).toBe(true);
		expect(providerElicitationDecisionAnswers({ behavior: "deny" })).toBeNull();
	});
});
