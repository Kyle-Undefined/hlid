import type { AgentToolDecision } from "./agentProvider";
import type { AskQuestion } from "./protocol";
import { ASK_USER_QUESTION_CANCEL_KEY } from "./protocol";

type ProviderElicitationPrimitive = string | number | boolean;
type ProviderElicitationStringFormat = "email" | "uri" | "date" | "date-time";

export type ProviderElicitationValue = ProviderElicitationPrimitive | string[];

export type ProviderElicitationField = {
	question: string;
	type: string;
	values: { keys(): IterableIterator<string> };
	freeText: boolean;
	placeholder?: string;
	optional?: boolean;
};

export type ParsedProviderElicitationField = ProviderElicitationField & {
	key: string;
	type: "string" | "number" | "integer" | "boolean" | "array";
	values: Map<string, ProviderElicitationPrimitive>;
	optional: boolean;
	minLength?: number;
	maxLength?: number;
	format?: ProviderElicitationStringFormat;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
};

export function isProviderInteractionRecord(
	value: unknown,
): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function firstProviderInteractionString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** Allow only browser-safe external URL schemes for provider elicitation cards. */
export function safeProviderElicitationUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function uniqueQuestion(base: string, key: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let candidate = `${base} (${key})`;
	let suffix = 2;
	while (used.has(candidate)) candidate = `${base} (${key} ${suffix++})`;
	used.add(candidate);
	return candidate;
}

function enumValues(
	property: Record<string, unknown>,
	type: ParsedProviderElicitationField["type"],
): Map<string, ProviderElicitationPrimitive> | null {
	const matchesType = (
		value: unknown,
	): value is ProviderElicitationPrimitive => {
		if (type === "string" || type === "array") {
			return typeof value === "string";
		}
		if (type === "boolean") return typeof value === "boolean";
		return typeof value === "number";
	};
	const values = new Map<string, ProviderElicitationPrimitive>();
	const rawEnum = property.enum;
	if (property.enumNames !== undefined && rawEnum === undefined) return null;
	if (property.oneOf !== undefined && property.anyOf !== undefined) return null;
	if (
		rawEnum !== undefined &&
		(property.oneOf !== undefined || property.anyOf !== undefined)
	) {
		return null;
	}
	if (rawEnum !== undefined) {
		if (!Array.isArray(rawEnum) || rawEnum.length === 0) return null;
		const enumNames = property.enumNames;
		if (
			enumNames !== undefined &&
			(!Array.isArray(enumNames) || enumNames.length !== rawEnum.length)
		) {
			return null;
		}
		for (const [index, value] of rawEnum.entries()) {
			if (!matchesType(value)) return null;
			const rawLabel = Array.isArray(enumNames) ? enumNames[index] : undefined;
			if (rawLabel !== undefined && typeof rawLabel !== "string") return null;
			const label =
				type === "string" && typeof rawLabel === "string" && rawLabel.trim()
					? rawLabel.trim()
					: String(value);
			if (values.has(label)) return null;
			values.set(label, value);
		}
	}
	const rawAlternatives = property.oneOf ?? property.anyOf;
	if (
		rawAlternatives !== undefined &&
		(!Array.isArray(rawAlternatives) || rawAlternatives.length === 0)
	) {
		return null;
	}
	const alternatives = Array.isArray(rawAlternatives) ? rawAlternatives : [];
	for (const alternative of alternatives) {
		if (!isProviderInteractionRecord(alternative)) return null;
		const value = alternative.const;
		if (!matchesType(value)) return null;
		const label =
			firstProviderInteractionString(alternative, ["title"]) ?? String(value);
		if (values.has(label)) return null;
		values.set(label, value);
	}
	return values;
}

function optionalNonNegativeInteger(
	record: Record<string, unknown>,
	key: string,
): number | null | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function optionalFiniteNumber(
	record: Record<string, unknown>,
	key: string,
): number | null | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringConstraints(
	property: Record<string, unknown>,
): Pick<
	ParsedProviderElicitationField,
	"minLength" | "maxLength" | "format"
> | null {
	const minLength = optionalNonNegativeInteger(property, "minLength");
	const maxLength = optionalNonNegativeInteger(property, "maxLength");
	if (minLength === null || maxLength === null) return null;
	if (
		minLength !== undefined &&
		maxLength !== undefined &&
		minLength > maxLength
	) {
		return null;
	}
	const format = property.format;
	if (
		format !== undefined &&
		format !== "email" &&
		format !== "uri" &&
		format !== "date" &&
		format !== "date-time"
	) {
		return null;
	}
	return {
		...(minLength !== undefined ? { minLength } : {}),
		...(maxLength !== undefined ? { maxLength } : {}),
		...(format !== undefined ? { format } : {}),
	};
}

function numberConstraints(
	property: Record<string, unknown>,
): Pick<ParsedProviderElicitationField, "minimum" | "maximum"> | null {
	const minimum = optionalFiniteNumber(property, "minimum");
	const maximum = optionalFiniteNumber(property, "maximum");
	if (minimum === null || maximum === null) return null;
	if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
		return null;
	}
	return {
		...(minimum !== undefined ? { minimum } : {}),
		...(maximum !== undefined ? { maximum } : {}),
	};
}

function arrayConstraints(
	property: Record<string, unknown>,
): Pick<ParsedProviderElicitationField, "minItems" | "maxItems"> | null {
	const minItems = optionalNonNegativeInteger(property, "minItems");
	const maxItems = optionalNonNegativeInteger(property, "maxItems");
	if (minItems === null || maxItems === null) return null;
	if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
		return null;
	}
	return {
		...(minItems !== undefined ? { minItems } : {}),
		...(maxItems !== undefined ? { maxItems } : {}),
	};
}

/** Parse the provider-neutral MCP primitive form-schema subset Hlid can render. */
export function parseProviderElicitationFields(
	requestedSchema: unknown,
): ParsedProviderElicitationField[] | null {
	if (!isProviderInteractionRecord(requestedSchema)) return null;
	// Claude's SDK exposes requestedSchema as a generic record and historically
	// forwards otherwise-valid object schemas with the top-level type omitted.
	// Codex supplies the explicit MCP object type, but retaining the implicit
	// form keeps the shared adapter backward-compatible without widening the
	// supported property shapes.
	if (requestedSchema.type !== undefined && requestedSchema.type !== "object") {
		return null;
	}
	if (!isProviderInteractionRecord(requestedSchema.properties)) return null;
	if (
		requestedSchema.required !== undefined &&
		(!Array.isArray(requestedSchema.required) ||
			requestedSchema.required.some((value) => typeof value !== "string"))
	) {
		return null;
	}
	const required = new Set(
		Array.isArray(requestedSchema.required) ? requestedSchema.required : [],
	);
	const usedQuestions = new Set<string>();
	const fields: ParsedProviderElicitationField[] = [];
	for (const [key, rawProperty] of Object.entries(requestedSchema.properties)) {
		if (
			!isProviderInteractionRecord(rawProperty) ||
			typeof rawProperty.type !== "string"
		) {
			return null;
		}
		const baseQuestion =
			firstProviderInteractionString(rawProperty, ["title"]) ?? key;
		const question = uniqueQuestion(baseQuestion, key, usedQuestions);
		const placeholder = firstProviderInteractionString(rawProperty, [
			"description",
		]);
		const optional = !required.has(key);
		switch (rawProperty.type) {
			case "string":
			case "number":
			case "integer": {
				const constraints =
					rawProperty.type === "string"
						? stringConstraints(rawProperty)
						: numberConstraints(rawProperty);
				if (!constraints) return null;
				const values = enumValues(rawProperty, rawProperty.type);
				if (!values) return null;
				fields.push({
					key,
					question,
					type: rawProperty.type,
					values,
					freeText: values.size === 0,
					optional,
					...constraints,
					...(placeholder ? { placeholder } : {}),
				});
				break;
			}
			case "boolean":
				fields.push({
					key,
					question,
					type: "boolean",
					values: new Map([
						["Yes", true],
						["No", false],
					]),
					freeText: false,
					optional,
					...(placeholder ? { placeholder } : {}),
				});
				break;
			case "array": {
				const constraints = arrayConstraints(rawProperty);
				if (!constraints) return null;
				if (!isProviderInteractionRecord(rawProperty.items)) return null;
				const itemType = rawProperty.items.type;
				if (itemType !== undefined && itemType !== "string") return null;
				const values = enumValues(rawProperty.items, "array");
				if (!values || values.size === 0) return null;
				fields.push({
					key,
					question,
					type: "array",
					values,
					freeText: false,
					optional,
					...constraints,
					...(placeholder ? { placeholder } : {}),
				});
				break;
			}
			default:
				return null;
		}
	}
	return fields.length > 0 ? fields : null;
}

function validCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= (days[month - 1] ?? 0);
}

function validStringFormat(
	value: string,
	format: ProviderElicitationStringFormat | undefined,
): boolean {
	if (format === undefined) return true;
	if (format === "email") {
		return /^[^\s@]+@[^\s@]+$/u.test(value);
	}
	if (format === "uri") {
		try {
			new URL(value);
			return true;
		} catch {
			return false;
		}
	}
	if (format === "date") return validCalendarDate(value);
	const match =
		/^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
			value,
		);
	if (!match || !validCalendarDate(match[1] ?? "")) return false;
	return (
		Number(match[2]) <= 23 &&
		Number(match[3]) <= 59 &&
		Number(match[4]) <= 59 &&
		(match[5] === undefined || Number(match[5]) <= 23) &&
		(match[6] === undefined || Number(match[6]) <= 59)
	);
}

function validStringValue(
	value: string,
	field: ParsedProviderElicitationField,
): boolean {
	const length = [...value].length;
	return (
		(field.minLength === undefined || length >= field.minLength) &&
		(field.maxLength === undefined || length <= field.maxLength) &&
		validStringFormat(value, field.format)
	);
}

function splitAnswer(raw: string): {
	selectionText: string;
	selections: string[];
	note: string;
} {
	const [selectionText = "", note = ""] = raw.split("\n\nNotes:", 2);
	return {
		selectionText,
		selections: selectionText ? selectionText.split(", ") : [],
		note: note.trim(),
	};
}

export function providerElicitationSelectedAnswer(
	answer: unknown,
): string | null {
	return typeof answer === "string" ? splitAnswer(answer).selectionText : null;
}

/** Convert Hlid question answers back into validated provider-native values. */
export function providerElicitationContent(
	fields: ParsedProviderElicitationField[],
	answers: Record<string, unknown>,
): Record<string, ProviderElicitationValue> | null {
	const content: Record<string, ProviderElicitationValue> = {};
	for (const field of fields) {
		const answer = answers[field.question];
		const raw = typeof answer === "string" ? answer : "";
		const { selectionText, selections, note } = splitAnswer(raw);
		if (!raw.trim() && !note) {
			if (field.optional) continue;
			return null;
		}
		if (field.type === "array") {
			const mapped: string[] = [];
			for (const selection of selections) {
				const value = field.values.get(selection);
				if (typeof value !== "string") return null;
				mapped.push(value);
			}
			if (mapped.length === 0 && !field.optional) return null;
			if (field.minItems !== undefined && mapped.length < field.minItems) {
				return null;
			}
			if (field.maxItems !== undefined && mapped.length > field.maxItems) {
				return null;
			}
			if (mapped.length > 0) content[field.key] = mapped;
			continue;
		}
		const selectedLabel = selectionText;
		const selected = field.values.get(selectedLabel);
		if (field.values.size > 0 && selected === undefined) return null;
		const value = (selected ?? selectionText) || note;
		if (field.type === "boolean") {
			if (typeof selected !== "boolean") return null;
			content[field.key] = selected;
		} else if (field.type === "number" || field.type === "integer") {
			const number = typeof selected === "number" ? selected : Number(value);
			if (!Number.isFinite(number)) return null;
			if (field.type === "integer" && !Number.isInteger(number)) return null;
			if (field.minimum !== undefined && number < field.minimum) return null;
			if (field.maximum !== undefined && number > field.maximum) return null;
			content[field.key] = number;
		} else if (
			typeof value === "string" &&
			value &&
			validStringValue(value, field)
		) {
			content[field.key] = value;
		} else {
			return null;
		}
	}
	return content;
}

export function providerElicitationDecisionAnswers(
	decision: AgentToolDecision | null,
): Record<string, unknown> | null {
	if (
		decision === null ||
		decision.behavior !== "allow" ||
		!isProviderInteractionRecord(decision.updatedInput)
	) {
		return null;
	}
	return isProviderInteractionRecord(decision.updatedInput.answers)
		? decision.updatedInput.answers
		: null;
}

export function providerElicitationWasCancelled(
	answers: Record<string, unknown> | null,
): boolean {
	return answers !== null && ASK_USER_QUESTION_CANCEL_KEY in answers;
}

/** Map provider-native schema fields onto Hlid's one durable question shape. */
export function providerElicitationQuestions(
	fields: ProviderElicitationField[],
): AskQuestion[] {
	return fields.map((field) => ({
		question: field.question,
		options: [...field.values.keys()],
		multiSelect: field.type === "array",
		...(field.freeText ? { freeText: true } : {}),
		...(field.type === "number" || field.type === "integer"
			? { inputType: "number" as const }
			: {}),
		...(field.placeholder ? { placeholder: field.placeholder } : {}),
		...(field.optional ? { optional: true } : {}),
	}));
}
