import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveServerDirectory } from "../src/experimental/server.ts";

afterEach(() => vi.unstubAllEnvs());

test("experimental server ignores inherited Pi state and uses Tau default", () => {
	vi.stubEnv("PI_SERVER_DIR", "/pi-server");
	vi.stubEnv("TAU_SERVER_DIR", undefined);
	expect(resolveServerDirectory()).toBe(join(homedir(), ".tau", "server"));
});

test("experimental server honors an explicit Tau directory", () => {
	vi.stubEnv("TAU_SERVER_DIR", "/tau-server");
	vi.stubEnv("PI_SERVER_DIR", "/pi-server");
	expect(resolveServerDirectory()).toBe("/tau-server");
});
