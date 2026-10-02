import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shareSession", () => {
	const originalFetch = globalThis.fetch;

	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		globalThis.fetch = originalFetch;
		childProcessMocks.spawn.mockReset();
	});

	it("uploads Radius shares with Tau-branded titles", async () => {
		const requestedTitles: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
			requestedTitles.push(url.searchParams.get("title") ?? "");
			return Response.json({ artifact: { canonical_url: "https://radius.test/session" } });
		}) as typeof fetch;
		const errors: string[] = [];
		const statuses: string[] = [];
		await shareSession({
			session: {
				sessionManager: { getSessionId: () => "tau", getCwd: () => "/tmp", getBranch: () => [] },
				state: { systemPrompt: "tau", tools: [] },
				modelRuntime: {
					getProvider: () => ({}),
					getAuth: async () => ({ auth: { headers: { Authorization: "Bearer radius-token" } } }),
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus(message: string) {
				statuses.push(message);
			},
			showError(message: string) {
				errors.push(message);
			},
		} as never);

		expect(requestedTitles).toEqual(["τ session"]);
		expect(errors).toEqual([]);
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toContain("Share URL:");
		expect(statuses[0]).toContain("https://radius.test/session");
	});

	it("keeps concurrent session exports isolated", async () => {
		const uploads: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
			uploads.push(readFileSync(args.at(-1)!, "utf8"));
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end(`https://gist.github.com/test/${uploads.length}\n`);
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});

		const aWritten = deferred();
		const bWritten = deferred();
		const releaseB = deferred();
		const errors: string[] = [];
		const context = (name: "A" | "B") => ({
			session: {
				sessionManager: {
					getSessionId: () => name,
					getCwd: () => "/tmp",
					getBranch: () => [],
				},
				state: { systemPrompt: name, tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, name);
					if (name === "A") {
						aWritten.resolve();
						await bWritten.promise;
					} else {
						bWritten.resolve();
						await releaseB.promise;
					}
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		});

		const shareA = shareSession(context("A") as never);
		await aWritten.promise;
		const shareB = shareSession(context("B") as never);
		await bWritten.promise;
		await shareA;
		releaseB.resolve();
		await shareB;

		expect(uploads).toEqual(["A", "B"]);
		expect(errors).toEqual([]);
	});
});
