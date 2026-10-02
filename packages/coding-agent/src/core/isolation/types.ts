export type SandboxNetwork = "off" | "on";
export interface IsolationRequest {
	projectDir: string;
	agentDir: string;
	installationDir: string;
	runtimeExecutable: string;
	runtimeEntry: string;
	args: readonly string[];
	network: SandboxNetwork;
	explicitEnvironment: Readonly<Record<string, string>>;
}
export interface IsolationPlan {
	backend: "bubblewrap";
	executable: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	cwd: string;
	exposures: readonly { path: string; access: "read-only" | "read-write" }[];
	network: SandboxNetwork;
}
