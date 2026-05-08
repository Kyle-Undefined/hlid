import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "./permissions";
import { PermissionManager } from "./permissions";

function makeReq(id: string): PermissionRequest {
	return {
		type: "permission_request",
		id,
		toolName: "Bash",
		title: `Run ${id}`,
	};
}

describe("PermissionManager", () => {
	it("starts with no pending requests", () => {
		const pm = new PermissionManager();
		expect(pm.getPending()).toEqual([]);
	});

	it("register adds to pending list", () => {
		const pm = new PermissionManager();
		const resolver = vi.fn();
		pm.register("t1", makeReq("t1"), resolver);
		expect(pm.getPending()).toHaveLength(1);
		expect(pm.getPending()[0].id).toBe("t1");
	});

	it("getPending returns all registered requests", () => {
		const pm = new PermissionManager();
		pm.register("a", makeReq("a"), vi.fn());
		pm.register("b", makeReq("b"), vi.fn());
		const ids = pm.getPending().map((r) => r.id);
		expect(ids).toContain("a");
		expect(ids).toContain("b");
	});

	it("duplicate registration throws", () => {
		const pm = new PermissionManager();
		pm.register("t1", makeReq("t1"), vi.fn());
		expect(() => pm.register("t1", makeReq("t1"), vi.fn())).toThrow(
			'duplicate registration for toolUseID "t1"',
		);
	});

	it("complete calls resolver with approved=true and removes entry", () => {
		const pm = new PermissionManager();
		const resolver = vi.fn();
		pm.register("t1", makeReq("t1"), resolver);
		pm.complete("t1", true);
		expect(resolver).toHaveBeenCalledWith(true, undefined);
		expect(pm.getPending()).toHaveLength(0);
	});

	it("complete calls resolver with approved=false", () => {
		const pm = new PermissionManager();
		const resolver = vi.fn();
		pm.register("t1", makeReq("t1"), resolver);
		pm.complete("t1", false);
		expect(resolver).toHaveBeenCalledWith(false, undefined);
	});

	it("complete passes saveScope to resolver", () => {
		const pm = new PermissionManager();
		const resolver = vi.fn();
		pm.register("t1", makeReq("t1"), resolver);
		pm.complete("t1", true, "session");
		expect(resolver).toHaveBeenCalledWith(true, "session");
	});

	it("complete with saveScope=local passes it through", () => {
		const pm = new PermissionManager();
		const resolver = vi.fn();
		pm.register("t1", makeReq("t1"), resolver);
		pm.complete("t1", true, "local");
		expect(resolver).toHaveBeenCalledWith(true, "local");
	});

	it("complete unknown id warns but does not throw", () => {
		const pm = new PermissionManager();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => pm.complete("nonexistent", true)).not.toThrow();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('"nonexistent"'),
		);
		warnSpy.mockRestore();
	});

	it("delete removes a single entry without resolving", () => {
		const pm = new PermissionManager();
		const resolver = vi.fn();
		pm.register("t1", makeReq("t1"), resolver);
		pm.register("t2", makeReq("t2"), vi.fn());
		pm.delete("t1");
		expect(resolver).not.toHaveBeenCalled();
		expect(pm.getPending().map((r) => r.id)).toEqual(["t2"]);
	});

	it("clearAll denies all pending and empties both maps", () => {
		const pm = new PermissionManager();
		const r1 = vi.fn();
		const r2 = vi.fn();
		pm.register("a", makeReq("a"), r1);
		pm.register("b", makeReq("b"), r2);
		pm.clearAll();
		expect(r1).toHaveBeenCalledWith(false);
		expect(r2).toHaveBeenCalledWith(false);
		expect(pm.getPending()).toHaveLength(0);
	});

	it("clearAll does not throw if a resolver throws", () => {
		const pm = new PermissionManager();
		const boom = vi.fn(() => {
			throw new Error("resolver error");
		});
		pm.register("t1", makeReq("t1"), boom);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => pm.clearAll()).not.toThrow();
		errorSpy.mockRestore();
	});

	it("can re-register after complete", () => {
		const pm = new PermissionManager();
		pm.register("t1", makeReq("t1"), vi.fn());
		pm.complete("t1", true);
		expect(() => pm.register("t1", makeReq("t1"), vi.fn())).not.toThrow();
	});
});
