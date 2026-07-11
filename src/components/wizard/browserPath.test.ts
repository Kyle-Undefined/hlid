import { describe, expect, it } from "vitest";
import { joinBrowserPath, parentBrowserPath } from "./browserPath";

describe("browser paths", () => {
	it.each([
		["/vault/projects", "/vault"],
		["/vault", "/"],
		["/", "/"],
		["C:\\Users\\person", "C:\\Users"],
		["C:\\Users", "C:\\"],
		["C:\\", "C:\\"],
	])("finds the parent of %s", (path, expected) => {
		expect(parentBrowserPath(path)).toBe(expected);
	});

	it.each([
		["/vault", "notes", "/vault/notes"],
		["/", "notes", "/notes"],
		["C:\\Users", "person", "C:\\Users\\person"],
		["C:\\", "Users", "C:\\Users"],
		["\\\\server\\share", "folder", "\\\\server\\share\\folder"],
	])("joins %s and %s", (base, name, expected) => {
		expect(joinBrowserPath(base, name)).toBe(expected);
	});
});
