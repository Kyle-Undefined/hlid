import { vi } from "vitest";

export const forbiddenResponse = vi.fn((_request?: Request) => null);
