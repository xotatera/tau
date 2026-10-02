import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getDocsPath, getExamplesPath, getReadmePath, SessionManager } from "@xotatera/tau-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../coding-agent/src/core/resource-loader.ts";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import {
	applyIsolatedEnvironment,
	createPiDocumentationEvalHarness,
	DOCUMENTATION_EVAL_TOOLS,
	excludePiDocumentation,
	resolveDocumentationVariant,
	resolveModelSelection,
	verifySystemPrompt,
} from "../src/harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults", () => {
		expect(resolveModelSelection(undefined, { PI_PROVIDER: " openai-codex ", PI_MODEL: " gpt-5.6-sol " })).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([{}, { PI_PROVIDER: "openai-codex" }, { PI_MODEL: "gpt-5.6-sol" }])(
		"rejects incomplete model selection",
		(environment) => {
			expect(() => resolveModelSelection(undefined, environment)).toThrow("Select a harness model explicitly");
		},
	);
});

describe("isolateProcessEnvironment", () => {
	it("overrides inherited Tau roots before discovery and restores them", async () => {
		const root = mkdtempSync(join(tmpdir(), "tau-eval-env-"));
		const host = join(root, "host"),
			home = join(root, "home"),
			agent = join(root, "agent"),
			project = join(root, "project"),
			marker = join(root, "executed");
		for (const directory of [join(host, "extensions"), home, agent, project])
			mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(host, "extensions", "host.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe"); export default function() {}`,
		);
		vi.stubEnv("TAU_CODING_AGENT_DIR", host);
		vi.stubEnv("TAU_CODING_AGENT_SESSION_DIR", join(host, "sessions"));
		const restore = applyIsolatedEnvironment(home, agent);
		try {
			expect(getAgentDir()).toBe(agent);
			expect(SessionManager.create(project).getSessionDir()).not.toContain(host);
			const loader = new DefaultResourceLoader({ cwd: project, agentDir: getAgentDir() });
			await loader.reload();
			expect(existsSync(marker)).toBe(false);
			expect(loader.getExtensions().extensions).toHaveLength(0);
		} finally {
			restore();
		}
		try {
			expect(getAgentDir()).toBe(host);
			expect(process.env.TAU_CODING_AGENT_SESSION_DIR).toBe(join(host, "sessions"));
		} finally {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("removes runner metadata and restores the process environment", () => {
		vi.stubEnv("PI_EVAL_VARIANT", "with_docs");
		vi.stubEnv("PI_EVAL_ARTIFACT_DIR", "/tmp/artifacts");
		const oldHome = process.env.HOME;
		try {
			const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
			try {
				expect(homedir()).toBe("/tmp/eval-home");
				expect(process.env.PI_CODING_AGENT_DIR).toBe("/tmp/eval-agent");
				expect(process.env.PI_EVAL_VARIANT).toBeUndefined();
				expect(process.env.PI_EVAL_ARTIFACT_DIR).toBeUndefined();
			} finally {
				restore();
			}
			expect(process.env.HOME).toBe(oldHome);
			expect(process.env.PI_EVAL_VARIANT).toBe("with_docs");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("documentation variant", () => {
	it.each(["without_docs", "with_docs"] as const)("accepts %s", (variant) => {
		expect(resolveDocumentationVariant(variant)).toBe(variant);
	});

	it.each([undefined, "", "other"])("rejects invalid variant %s", (variant) => {
		expect(() => resolveDocumentationVariant(variant)).toThrow("PI_EVAL_VARIANT");
	});

	it("strips only the documentation routing section from the default Pi prompt", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		expect(prompt).toContain("\n<docs>\nPi documentation (read only");
		expect(prompt).toContain("\n<rules>\n");
		expect(prompt).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(prompt).toContain("docs/models.md");

		const stripped = excludePiDocumentation(prompt);
		expect(stripped).toContain("\n<rules>\n");
		expect(stripped).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(stripped).not.toContain("<docs>");
		expect(stripped).not.toContain("Pi documentation");
		expect(stripped).not.toContain("docs/models.md");
		expect(stripped).not.toContain(getReadmePath());
		expect(stripped).not.toContain(getDocsPath());
		expect(stripped).not.toContain(getExamplesPath());
	});

	it("verifies the prompt that was sent", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		const stripped = excludePiDocumentation(prompt);

		expect(verifySystemPrompt(stripped, { name: "without_docs", expectedPiDocumentation: false })).toBe(stripped);
		expect(() => verifySystemPrompt(prompt, { name: "without_docs", expectedPiDocumentation: false })).toThrow(
			"does not match",
		);
	});

	it("fails closed when prompt markers are missing", () => {
		expect(() => excludePiDocumentation("Instructions")).toThrow("no Pi documentation section");
		expect(() => excludePiDocumentation("\n<docs>\nPi documentation\n</docs>")).toThrow(
			"no working-directory section",
		);
	});

	it("rejects documentation harnesses outside the container sandbox", () => {
		expect(() => createPiDocumentationEvalHarness()).toThrow("isolated container sandbox");
	});
});
