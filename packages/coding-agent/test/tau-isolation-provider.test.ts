import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startMockProvider } from "./fixtures/tau-compat/mock-provider-server.ts";

it("production OAuth login refresh persistence and streaming work inside the default online sandbox", async () => {
	const root = mkdtempSync(join(tmpdir(), "tau-isolation-provider-"));
	const server = await startMockProvider();
	const project = join(root, "project"),
		agent = join(root, "agent"),
		home = join(root, "home");
	for (const dir of [project, agent, home]) mkdirSync(dir);
	const pi = join(home, ".pi", "agent");
	mkdirSync(pi, { recursive: true });
	writeFileSync(join(pi, "auth.json"), "synthetic-pi-untouched");
	const extension = join(project, "subscription.ts");
	writeFileSync(
		extension,
		`import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
export default function(pi) {
 pi.on("session_start", async (_event, ctx) => {
  try {
   assert.equal(process.env.OPENAI_API_KEY, "synthetic-selected-key");
   assert.equal(process.env.HTTP_PROXY, ${JSON.stringify(server.url)});
   const base = ${JSON.stringify(server.url)};
   const authPath = ${JSON.stringify(join(agent, "auth.json"))};
   const runtime = await ModelRuntime.create({ authPath, modelsPath: null });
   const config = { name: "Local subscription", baseUrl: base + "/v1", api: "openai-completions", oauth: {
    name: "Local subscription", isSubscription: true,
    async login(callbacks) {
     let receive; const codePromise = new Promise(resolve => receive = resolve);
     const listener = createServer((request, response) => { receive(new URL(request.url, "http://127.0.0.1").searchParams.get("code")); response.end("Authorized"); });
     await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
     try {
      const redirect = "http://127.0.0.1:" + listener.address().port + "/callback";
      callbacks.onAuth({ url: base + "/authorize?redirect_uri=" + encodeURIComponent(redirect), instructions: "Open this URL manually if a browser is unavailable" });
      const code = await codePromise;
      return await (await fetch(base + "/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code }) })).json();
     } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    },
    async refreshToken(credential, signal) { return await (await fetch(base + "/token", { method: "POST", signal, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh }) })).json(); },
    getApiKey: credential => credential.access,
   }, models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 128 }] };
   runtime.registerProvider("local-subscription", config);
   if (existsSync(${JSON.stringify(join(project, "offline"))})) {
    const model = runtime.getModel("local-subscription", "probe");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
     const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "must-not-connect", timestamp: 1 }] }, { signal: controller.signal });
     assert.ok(["error", "aborted"].includes(result.stopReason));
     assert.ok(result.errorMessage);
     writeFileSync(${JSON.stringify(join(project, "offline-report"))}, "denied");
    } finally { clearTimeout(timer); }
    ctx.shutdown(); return;
   }
   let notified = false; let authorization;
   await runtime.login("local-subscription", "oauth", { notify(event) { if (event.type === "auth_url") { notified = event.instructions.includes("manually"); authorization = fetch(event.url); } }, async prompt() { throw new Error("Unexpected prompt"); } });
   await authorization;
   assert.equal(notified, true);
   const restarted = await ModelRuntime.create({ authPath, modelsPath: null });
   restarted.registerProvider("local-subscription", config);
   const model = restarted.getModel("local-subscription", "probe");
   assert.ok(model);
   const stream = restarted.streamSimple(model, { messages: [{ role: "user", content: "local-only", timestamp: 1 }] });
   let chunks = 0;
   for await (const event of stream) if (event.type === "text_delta") chunks++;
   const result = await stream.result();
   assert.equal(result.stopReason, "stop");
   assert.equal(result.content.filter(item => item.type === "text").map(item => item.text).join(""), "local response");
   assert.ok(chunks >= 1);
   const controller = new AbortController();
   const cancelled = restarted.streamSimple(model, { messages: [{ role: "user", content: "cancel-me", timestamp: 1 }] }, { signal: controller.signal });
   for await (const event of cancelled) if (event.type === "text_delta") controller.abort();
   assert.equal((await cancelled.result()).stopReason, "aborted");
   writeFileSync(${JSON.stringify(join(project, "report.json"))}, JSON.stringify({ login: true, restart: true, streaming: true }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  ctx.shutdown();
 });
}
`,
	);
	// Startup model never sends a request; the extension drives only the local provider.
	writeFileSync(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				bootstrap: {
					baseUrl: `${server.url}/v1`,
					api: "openai-completions",
					models: [
						{
							id: "probe",
							name: "Probe",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1024,
							maxTokens: 128,
						},
					],
				},
			},
		}),
	);
	async function run(network: "on" | "off") {
		return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					new URL("../src/experimental/source-resolver.ts", import.meta.url).href,
					fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
					"--isolated",
					`--sandbox-network=${network}`,
					"--sandbox-env",
					"OPENAI_API_KEY",
					"--sandbox-env",
					"HTTP_PROXY",
					"--offline",
					"-p",
					"--no-session",
					"--no-builtin-tools",
					"--no-context-files",
					"--model",
					"bootstrap/probe",
					"--api-key",
					"synthetic-bootstrap",
					"-e",
					extension,
				],
				{
					cwd: project,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						TAU_CODING_AGENT_DIR: agent,
						OPENAI_API_KEY: "synthetic-selected-key",
						HTTP_PROXY: server.url,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk) => {
				output += chunk;
			});
			const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, output });
			});
		});
	}
	try {
		const result = await run("on");
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(readFileSync(join(project, "report.json"), "utf8"))).toEqual({
			login: true,
			restart: true,
			streaming: true,
		});
		expect(server.counts).toMatchObject({ authorize: 1, exchange: 1, refresh: 1, stream: 2 });
		expect(server.counts.proxy).toBeGreaterThan(0);
		expect(result.output).not.toContain("synthetic-selected-key");
		expect(readFileSync(join(agent, "auth.json"), "utf8")).toContain("synthetic-refreshed");
		expect(result.output).not.toContain("synthetic-refreshed");
		expect(result.output).not.toContain("synthetic-refresh");
		const beforeOffline = { ...server.counts };
		writeFileSync(join(project, "offline"), "off");
		const offline = await run("off");
		expect(offline.code, offline.output).toBe(0);
		expect(readFileSync(join(project, "offline-report"), "utf8")).toBe("denied");
		expect(offline.output).toContain("Networking is off");
		expect(server.counts).toEqual(beforeOffline);
		expect(readFileSync(join(pi, "auth.json"), "utf8")).toBe("synthetic-pi-untouched");
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
