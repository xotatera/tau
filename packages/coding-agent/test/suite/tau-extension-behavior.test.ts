import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

// Compatibility guards: these pin upstream event semantics, not new Tau behavior.
describe("Tau extension session behavior", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("preserves factory and context transformation order", async () => {
		const order: string[] = [];
		let received = "";
		const harness = await createHarness({
			extensionFactories: ["A", "B"].map((suffix) => (pi: ExtensionAPI) => {
				order.push(suffix);
				pi.on("context", (event) => ({
					messages: event.messages.map((message) =>
						message.role === "user"
							? { ...message, content: [{ type: "text" as const, text: getMessageText(message) + suffix }] }
							: message,
					),
				}));
			}),
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				received = getMessageText(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("ask");
		expect(order).toEqual(["A", "B"]);
		expect(received).toBe("askAB");
	});

	it("chains tool-result transformations in registration order", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.registerTool({
						name: "compat_echo",
						label: "Echo",
						description: "Test",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "original" }], details: {} };
						},
					}),
				...["A", "B"].map((suffix) => (pi: ExtensionAPI) => {
					pi.on("tool_result", (event) => ({
						content: [{ type: "text" as const, text: getMessageText(event) + suffix }],
					}));
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("compat_echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call the probe");
		expect(getMessageText(getToolResult(harness, "compat_echo"))).toBe("originalAB");
	});

	it("short-circuits handled input before later handlers or a provider request", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						order.push("handled");
						return { action: "handled" };
					});
				},
				(pi) => {
					pi.on("input", () => {
						order.push("late");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain queued")]);
		await harness.session.prompt("handled input");
		expect(order).toEqual(["handled"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toEqual([]);
	});

	it("blocks tool execution when its tool-call handler throws", async () => {
		let executions = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "compat_block",
						label: "Block",
						description: "Test",
						parameters: Type.Object({}),
						async execute() {
							executions++;
							return { content: [{ type: "text", text: "unsafe" }], details: {} };
						},
					});
					pi.on("tool_call", () => {
						throw new Error("denied by handler");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("compat_block", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("try blocked tool");
		expect(executions).toBe(0);
		expect(getToolResult(harness, "compat_block").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "compat_block"))).toContain("denied by handler");
	});

	it("keeps a removed pending handler for the current dispatch only", async () => {
		const calls: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						calls.push("A");
						stopB();
					});
					const stopB = pi.on("agent_end", () => {
						calls.push("B");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(calls).toEqual(["A", "B", "A"]);
	});

	it("runs parallel extension tools without serializing independent calls", async () => {
		const entered: string[] = [];
		let release!: () => void;
		const bothEntered = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					for (const name of ["parallel_a", "parallel_b"])
						pi.registerTool({
							name,
							label: name,
							description: "Parallel probe",
							parameters: Type.Object({}),
							async execute() {
								entered.push(name);
								if (entered.length === 2) release();
								await bothEntered;
								return { content: [{ type: "text", text: name }], details: {} };
							},
						});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parallel_a", {}), fauxToolCall("parallel_b", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("parallel probes");
		expect(entered.sort()).toEqual(["parallel_a", "parallel_b"]);
		expect(getMessageText(getToolResult(harness, "parallel_a"))).toBe("parallel_a");
		expect(getMessageText(getToolResult(harness, "parallel_b"))).toBe("parallel_b");
	}, 5000);

	it("reloads twice with one live subscription and rejects captured stale contexts", async () => {
		const root = mkdtempSync(join(tmpdir(), "tau-reload-"));
		const eventBus = createEventBus();
		let calls = 0;
		const contexts: ExtensionContext[] = [];
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			eventBus,
			extensionFactories: [
				(pi) => {
					pi.events.on("tau-reload-probe", () => {
						calls++;
					});
					pi.on("session_start", (_event, ctx) => {
						contexts.push(ctx);
					});
				},
			],
		});
		try {
			await loader.reload();
			const harness = await createHarness({ resourceLoader: loader });
			harnesses.push(harness);
			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			await harness.session.reload();
			await harness.session.reload();
			eventBus.emit("tau-reload-probe", undefined);
			expect(calls).toBe(1);
			expect(contexts.length).toBe(3);
			expect(() => contexts[0]!.cwd).toThrow("stale");
			expect(() => contexts[1]!.sessionManager).toThrow("stale");
			expect(contexts[2]!.cwd).toBe(harness.tempDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rolls back failed-factory subscriptions and queued provider registrations", async () => {
		const root = mkdtempSync(join(tmpdir(), "tau-rollback-"));
		const eventBus = createEventBus();
		let calls = 0;
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			eventBus,
			extensionFactories: [
				(pi) => {
					pi.events.on("tau-failed-factory", () => {
						calls++;
					});
					pi.registerProvider("tau-failed-provider", { baseUrl: "http://127.0.0.1:1", models: [] });
					throw new Error("intentional factory failure");
				},
			],
		});
		try {
			await loader.reload();
			eventBus.emit("tau-failed-factory", undefined);
			const result = loader.getExtensions();
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.error).toContain("intentional factory failure");
			expect(result.extensions).toEqual([]);
			expect(result.runtime.pendingProviderRegistrations).toEqual([]);
			expect(calls).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("dispatches commands and flags with mode-specific UI without a terminal", async () => {
		const notifications: string[] = [];
		const runs: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerFlag("compat-ui", { type: "boolean", default: true });
					pi.registerCommand("compat", {
						handler: async (args, ctx) => {
							runs.push(`${args}:${pi.getFlag("compat-ui")}:${ctx.hasUI}`);
							if (ctx.hasUI) ctx.ui.notify("compat command");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);
		await harness.session.bindExtensions({ mode: "print" });
		await harness.session.prompt("/compat headless");
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ notify: (text) => notifications.push(text) }),
		});
		await harness.session.prompt("/compat interactive");
		expect(runs).toEqual(["headless:true:false", "interactive:true:true"]);
		expect(notifications).toEqual(["compat command"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
