import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

// Internal packages, including the Tau host, follow the same exact-pin rule as external ones.
for (const [name, specifier, status] of [
	["@xotatera/tau-coding-agent", "^1.0.0", 1],
	["@xotatera/tau-coding-agent", "1.2.0", 0],
	["@xotatera/unrelated", "^1.0.0", 1],
] as const) {
	test(`dependency pin validation ${status === 0 ? "accepts" : "rejects"} ${name}@${specifier}`, () => {
		const root = mkdtempSync(join(tmpdir(), "tau-pinned-"));
		try {
			writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { [name]: specifier } }));
			const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
			assert.equal(result.status, status, result.stderr);
			if (status !== 0) assert.match(result.stderr, /must be pinned/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
