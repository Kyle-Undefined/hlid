import type { AskQuestion } from "./protocol";

export type ProviderElicitationField = {
	question: string;
	type: string;
	values: { keys(): IterableIterator<string> };
	freeText: boolean;
	placeholder?: string;
	optional?: boolean;
};

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
