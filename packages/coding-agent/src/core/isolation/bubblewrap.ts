import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { IsolationPlan } from "./types.ts";

/** No user runtime is evaluated during preflight; the exact namespace runs Node only. */
export async function preflightIsolation(plan: IsolationPlan): Promise<void> {
	const boundary = plan.argv.indexOf("--");
	if (boundary < 0) throw new Error("Invalid isolation plan");
	const args = [...plan.argv.slice(0, boundary + 2), "-e", "process.exit(0)"];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(plan.executable, args, { cwd: plan.cwd, env: plan.env, stdio: "ignore" });
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("error", () => {
			clearTimeout(timer);
			reject(new Error("Isolation backend unavailable; refusing unisolated fallback"));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error("Isolation preflight failed; check bubblewrap, namespaces and runtime files"));
		});
	});
}

export async function runIsolation(plan: IsolationPlan): Promise<number> {
	return await runChild(plan.executable, plan.argv, plan.env, plan.cwd);
}

export async function runChild(
	executable: string,
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const child = spawn(executable, [...argv], { cwd, env, stdio: "inherit" });
		let killTimer: NodeJS.Timeout | undefined;
		const relay = (signal: NodeJS.Signals) => {
			child.kill(signal);
			killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1500);
			killTimer.unref();
		};
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
		const handlers = signals.map((signal) => {
			const handler = () => relay(signal);
			process.on(signal, handler);
			return handler;
		});
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			signals.forEach((signal, i) => {
				process.off(signal, handlers[i]!);
			});
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
		});
	});
}
