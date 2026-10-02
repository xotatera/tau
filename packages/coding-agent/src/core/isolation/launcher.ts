import { existsSync, mkdirSync } from "node:fs";
import { getAgentDir, getCliInstallationDir, getCliRuntimePath, isBunRuntime } from "../../config.ts";
import { preflightIsolation, runChild, runIsolation } from "./bubblewrap.ts";
import { buildIsolationPlan, validateEnvironmentName } from "./policy.ts";
import type { SandboxNetwork } from "./types.ts";

export async function launchTau(args: readonly string[]): Promise<number> {
	let isolated = false;
	let network: SandboxNetwork = "on";
	let sandboxOption = false;
	const forwarded: string[] = [];
	const explicitEnvironment: Record<string, string> = {};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--") {
			forwarded.push(...args.slice(index));
			break;
		}
		if (argument === "--isolated") {
			isolated = true;
			continue;
		}
		if (argument.startsWith("--sandbox-network=")) {
			const value = argument.slice("--sandbox-network=".length);
			if (value !== "on" && value !== "off") throw new Error("Invalid sandbox network policy");
			network = value;
			sandboxOption = true;
			continue;
		}
		if (argument === "--sandbox-env") {
			const name = args[++index];
			if (!name) throw new Error("Missing sandbox environment name");
			validateEnvironmentName(name);
			const value = process.env[name];
			if (value === undefined) throw new Error(`Selected environment variable is not set: ${name}`);
			explicitEnvironment[name] = value;
			sandboxOption = true;
			continue;
		}
		if (argument.startsWith("--sandbox-") || argument.startsWith("--isolated="))
			throw new Error("Unknown sandbox option");
		forwarded.push(argument);
	}
	if (!isolated && sandboxOption) throw new Error("Sandbox options require --isolated");
	if (isolated && (process.platform !== "linux" || isBunRuntime))
		throw new Error("Isolation requires the Linux Node runtime");
	const runtime = getCliRuntimePath();
	if (!isolated)
		return await runChild(process.execPath, [...process.execArgv, runtime, ...forwarded], process.env, process.cwd());
	const agentDir = getAgentDir();
	// State selection is explicit; no settings or extension code is loaded here.
	if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const plan = buildIsolationPlan({
		projectDir: process.cwd(),
		agentDir,
		installationDir: getCliInstallationDir(),
		runtimeExecutable: process.execPath,
		runtimeEntry: runtime,
		args: forwarded,
		network,
		explicitEnvironment,
	});
	await preflightIsolation(plan);
	console.error(`Tau isolation: ${plan.exposures.map((item) => `${item.access}: ${item.path}`).join("; ")}`);
	console.error(`Forwarded environment names: ${Object.keys(explicitEnvironment).join(", ") || "none"}`);
	console.error(
		network === "on"
			? "Networking is on: no endpoint filtering, host-loopback/service isolation, or protection from exfiltration of exposed data."
			: "Networking is off; provider failures will not enable it.",
	);
	return await runIsolation(plan);
}
