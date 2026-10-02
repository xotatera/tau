import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { readObject } from "../pi-import/inventory.ts";
import { runtimePackageClosure } from "./runtime-closure.ts";
import type { IsolationPlan, IsolationRequest } from "./types.ts";

export function containsPath(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

export function validateEnvironmentName(name: string): void {
	// Only provider credentials/endpoints and proxy settings; never runtime/loader configuration.
	if (
		!/^(?:(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|GROQ|XAI|OPENROUTER|MISTRAL|DEEPSEEK|AZURE_OPENAI)_(?:API_KEY|BASE_URL|ENDPOINT)|(?:HTTP|HTTPS|ALL|NO)_PROXY)$/.test(
			name,
		)
	)
		throw new Error("Invalid or reserved sandbox environment name");
}

function rejectPiInstallation(directory: string): void {
	const manifest = join(directory, "package.json");
	if (existsSync(manifest)) {
		let name: unknown;
		try {
			name = readObject(manifest).name;
		} catch {
			/* Unrelated malformed project metadata is not Pi identity. */
		}
		if (name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent")
			throw new Error("Sandbox selection exposes a Pi installation");
	}
	if (
		basename(directory) === "pi-coding-agent" &&
		["@earendil-works", "@mariozechner"].includes(basename(dirname(directory)))
	)
		throw new Error("Sandbox selection exposes a Pi installation");
}

export function buildIsolationPlan(request: IsolationRequest): IsolationPlan {
	if (process.platform !== "linux") throw new Error("Isolation requires Linux and bubblewrap");
	const backend = (process.env.PATH ?? "")
		.split(":")
		.map((directory) => join(directory, "bwrap"))
		.find((path) => existsSync(path));
	if (!backend || realpathSync(backend) !== "/usr/bin/bwrap")
		throw new Error("Trusted bubblewrap backend unavailable");
	if (request.network !== "on" && request.network !== "off") throw new Error("Invalid sandbox network policy");
	for (const [name, value] of Object.entries(request.explicitEnvironment)) {
		validateEnvironmentName(name);
		if (value.includes("\0")) throw new Error("Invalid sandbox environment value");
	}
	const home = realpathSync(homedir());
	const forbidden = [
		join(home, ".pi"),
		process.env.PI_PACKAGE_DIR,
		process.env.PI_CODING_AGENT_DIR,
		join(home, ".bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent"),
		join(home, ".bun", "install", "global", "node_modules", "@mariozechner", "pi-coding-agent"),
	]
		.filter((path): path is string => !!path && existsSync(path))
		.map((path) => realpathSync(path));
	const roots = [request.projectDir, request.agentDir, request.installationDir].map((path) => {
		const canonical = realpathSync(path);
		for (let ancestor = canonical; ; ancestor = dirname(ancestor)) {
			rejectPiInstallation(ancestor);
			if (dirname(ancestor) === ancestor) break;
		}
		if (forbidden.some((hidden) => containsPath(canonical, hidden) || containsPath(hidden, canonical)))
			throw new Error("Sandbox root exposes Pi state or installation");
		if (
			!statSync(canonical).isDirectory() ||
			containsPath(canonical, home) ||
			canonical.split(sep).includes(".pi") ||
			["/", "/usr", "/etc", "/var", "/tmp", "/run", "/proc", "/dev", "/sys"].includes(canonical)
		)
			throw new Error("Unsafe sandbox root selection");
		return canonical;
	});
	const [project, agent, installation] = roots as [string, string, string];
	for (let i = 0; i < roots.length; i++)
		for (let j = i + 1; j < roots.length; j++) {
			if (containsPath(roots[i]!, roots[j]!) || containsPath(roots[j]!, roots[i]!))
				throw new Error("Sandbox roots overlap");
		}
	const runtime = realpathSync(request.runtimeExecutable);
	if (!containsPath("/usr/bin", runtime) || basename(runtime) !== "node")
		throw new Error("Unsupported sandbox runtime layout");
	const entry = realpathSync(request.runtimeEntry);
	if (!containsPath(installation, entry) || !statSync(entry).isFile())
		throw new Error("Runtime entry escapes installation");
	for (const argument of request.args)
		if (argument.split(/[\\/]/).includes(".pi"))
			throw new Error("Source-Pi direct reuse is unavailable in isolation; import first");
	const argv = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/tau-home",
	];
	if (request.network === "off") argv.push("--unshare-net");
	const exposures: Array<{ path: string; access: "read-only" | "read-write" }> = [];
	const mounted = new Set<string>();
	function mount(path: string, writable = false): void {
		if (mounted.has(path)) return;
		mounted.add(path);
		argv.push(writable ? "--bind" : "--ro-bind", path, path);
		exposures.push({ path, access: writable ? "read-write" : "read-only" });
	}
	mount(project, true);
	mount(agent, true);
	mount(installation);
	const closure = runtimePackageClosure(installation);
	for (const { source, destination } of closure) {
		rejectPiInstallation(source);
		if (forbidden.some((hidden) => containsPath(source, hidden) || containsPath(hidden, source)))
			throw new Error("Runtime dependency exposes Pi state or installation");
		if (
			source.split(sep).includes(".pi") ||
			containsPath(source, home) ||
			containsPath(source, project) ||
			containsPath(source, agent)
		)
			throw new Error("Unsafe runtime dependency root");
		mount(source);
		if (source !== destination) argv.push("--symlink", source, destination);
	}
	const nodeArgs: string[] = [];
	if (entry.endsWith(".ts")) {
		const repository = dirname(dirname(installation));
		const resolver = join(installation, "src", "experimental", "source-resolver.ts");
		if (!existsSync(resolver) || !existsSync(join(repository, "tsconfig.json")))
			throw new Error("Unsupported source runtime layout");
		mount(join(repository, "tsconfig.json"));
		mount(join(repository, "tsconfig.base.json"));
		mount(join(repository, "package.json"));
		nodeArgs.push("--import", resolver);
	}
	// Explicit command closure; never mount all /usr/bin or /usr/lib.
	const systemEnvironment = { PATH: "/usr/bin:/bin", LANG: "C" };
	const binaries = new Set([runtime, realpathSync("/bin/bash")]);
	for (const name of [
		"ls",
		"grep",
		"find",
		"git",
		"cat",
		"sed",
		"head",
		"tail",
		"wc",
		"sort",
		"cut",
		"tr",
		"mkdir",
		"cp",
		"mv",
		"rm",
		"touch",
		"chmod",
		"readlink",
		"stat",
		"date",
		"env",
		"xargs",
		"tee",
		"diff",
		"sleep",
		"timeout",
		"rg",
	]) {
		const path = join("/usr/bin", name);
		if (!existsSync(path)) {
			if (["ls", "grep", "find", "git"].includes(name)) throw new Error(`Missing required sandbox command: ${name}`);
			continue;
		}
		const canonical = realpathSync(path);
		if (!containsPath("/usr/bin", canonical)) throw new Error("Unsupported sandbox command layout");
		binaries.add(canonical);
		if (canonical !== path) argv.push("--symlink", canonical, path);
	}
	const gitHelpers = realpathSync(
		execFileSync("/usr/bin/git", ["--exec-path"], { env: systemEnvironment, encoding: "utf8", timeout: 5000 }).trim(),
	);
	if (!["/usr/lib/git-core", "/usr/libexec/git-core"].includes(gitHelpers))
		throw new Error("Unsupported git helper layout");
	mount(gitHelpers);
	for (const name of readdirSync(gitHelpers)) {
		const path = realpathSync(join(gitHelpers, name));
		if (!containsPath(gitHelpers, path) && !containsPath("/usr/bin", path))
			throw new Error("Git helper escapes supported system roots");
		if (
			statSync(path).isFile() &&
			readFileSync(path)
				.subarray(0, 4)
				.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
		)
			binaries.add(path);
	}
	if (existsSync("/usr/share/git-core/templates")) mount("/usr/share/git-core/templates");
	// Resolve only trusted ELF executables, with no caller-supplied loader environment.
	for (const binary of binaries) {
		mount(binary);
		const libraries = execFileSync("/usr/bin/ldd", [binary], {
			env: systemEnvironment,
			encoding: "utf8",
			timeout: 5000,
		});
		if (libraries.includes("not found")) throw new Error("Missing runtime library");
		for (const library of libraries.match(/\/[^\s()]+/g) ?? []) {
			const canonical = realpathSync(library);
			if (
				!containsPath("/usr/lib", canonical) &&
				!containsPath("/usr/lib64", canonical) &&
				!containsPath("/lib", canonical) &&
				!containsPath("/lib64", canonical)
			)
				throw new Error("Unsupported system library layout");
			mount(library);
		}
	}
	argv.push("--symlink", realpathSync("/bin/bash"), "/bin/bash", "--symlink", realpathSync("/bin/bash"), "/bin/sh");
	for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/cert.pem", "/etc/ssl/certs"])
		if (existsSync(path)) mount(path);
	// Walk without following symlinks: hidden source paths remain absent in the namespace.
	let scanned = 0;
	function hide(directory: string): void {
		rejectPiInstallation(directory);
		for (const name of readdirSync(directory)) {
			if (++scanned > 100_000) throw new Error("Sandbox tree exceeds inspection limit");
			const path = join(directory, name);
			const metadata = lstatSync(path);
			if (metadata.isSymbolicLink()) {
				if ([".pi", ".ssh", ".aws", ".gnupg"].includes(name)) throw new Error("Unsupported hidden path alias");
				continue;
			}
			if ([".pi", ".ssh", ".aws", ".gnupg"].includes(name)) {
				if (!metadata.isDirectory()) throw new Error("Unsupported hidden path layout");
				argv.push("--tmpfs", path, "--remount-ro", path);
			} else if (
				metadata.isSocket() ||
				metadata.isFIFO() ||
				metadata.isBlockDevice() ||
				metadata.isCharacterDevice()
			) {
				throw new Error("Sandbox root contains an unsupported socket or special file");
			} else if (metadata.isDirectory()) hide(path);
		}
	}
	for (const root of new Set([...roots, ...closure.map((item) => item.source)])) hide(root);
	const env = {
		HOME: "/tau-home",
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		TMPDIR: "/tmp",
		TAU_CODING_AGENT_DIR: agent,
		PI_TELEMETRY: "0",
		...request.explicitEnvironment,
	};
	argv.push("--chdir", project, "--", runtime, ...nodeArgs, entry, ...request.args);
	return {
		backend: "bubblewrap",
		executable: "/usr/bin/bwrap",
		argv,
		env,
		cwd: project,
		exposures,
		network: request.network,
	};
}
