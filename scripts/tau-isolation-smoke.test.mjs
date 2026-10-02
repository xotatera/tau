import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { smokeIsolation } from "./tau-isolation-smoke.mjs";

test("real source and bundled namespaces preserve imported legacy extension registrations", { timeout: 60000 }, smokeIsolation);

test("the isolation smoke uses trusted system Node when the parent runs from a different path", { timeout: 60000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "tau-non-system-node-"));
	try {
		const alternateNode = join(root, "node");
		cpSync(process.execPath, alternateNode);
		const result = spawnSync(alternateNode, [fileURLToPath(new URL("./tau-isolation-smoke.mjs", import.meta.url))], {
			encoding: "utf8",
			timeout: 60000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Source and bundled isolation: imported unchanged fixture/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
