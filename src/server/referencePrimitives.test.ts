import { describe, expect, it } from "vitest";
import {
	finalizeReferenceIndex,
	isSafeRelativeReference,
	referenceIndexTruncationAtLimit,
	searchReferenceIndex,
} from "./referencePrimitives";

describe("reference primitives", () => {
	it("accepts only non-empty relative paths without traversal", () => {
		expect(isSafeRelativeReference("Projects/Hlið Plan.md")).toBe(true);
		expect(isSafeRelativeReference("Projects\\Hlið Plan.md")).toBe(true);
		expect(isSafeRelativeReference("Projects//Hlið Plan.md")).toBe(true);
		for (const path of [
			"",
			"/absolute.md",
			"C:\\absolute.md",
			"Projects/../secret.md",
			"Projects/note.md\0",
		]) {
			expect(isSafeRelativeReference(path)).toBe(false);
		}
	});

	it("sorts shallow paths before deeper paths and then by path", () => {
		const items = [
			{ relativePath: "z/deep.md", name: "deep.md" },
			{ relativePath: "Root.md", name: "Root.md" },
			{ relativePath: "a/deep.md", name: "deep.md" },
		];
		const index = finalizeReferenceIndex("/vault", items, true, 42);
		expect(index.items.map((item) => item.relativePath)).toEqual([
			"Root.md",
			"a/deep.md",
			"z/deep.md",
		]);
		expect(index).toMatchObject({
			root: "/vault",
			builtAt: 42,
			truncated: true,
		});
		expect(referenceIndexTruncationAtLimit(2, 3, true)).toBeNull();
		expect(referenceIndexTruncationAtLimit(3, 3, false)).toBe(false);
	});

	it("normalizes, ranks, limits, and reports truncated matches", () => {
		const items = [
			{ relativePath: "Alpha.md", name: "Alpha.md" },
			{ relativePath: "notes/My Alpha.md", name: "My Alpha.md" },
			{ relativePath: "projects/alpha/Readme.md", name: "Readme.md" },
			{ relativePath: "Other.md", name: "Other.md" },
		];
		expect(
			searchReferenceIndex(items, {
				query: "álpha",
				limit: 2,
				defaultLimit: 48,
				maxLimit: 100,
			}),
		).toEqual({
			items: [items[0], items[1]],
			total: 3,
			truncated: true,
		});
		expect(
			searchReferenceIndex(items, {
				limit: 0,
				defaultLimit: 48,
				maxLimit: 100,
			}).items,
		).toEqual([items[0]]);
	});
});
