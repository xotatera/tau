import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inventoryPiImport, readObject } from "../core/pi-import/inventory.ts";
import { generationPath, validateGeneration } from "../core/pi-import/snapshot.ts";
import { importRoot, OWNER } from "../core/pi-import/storage.ts";
import { activatePiImport, applyPiImport } from "../core/pi-import/transaction.ts";
import type { ImportOptions } from "../core/pi-import/types.ts";

export async function handlePiImportCommand(args: readonly string[], agentDir: string): Promise<boolean> {
	if (args[0] !== "import") return false;
	try {
		if (args[1] === "activate") {
			if (args.length !== 3 || !/^[a-f0-9]{64}$/.test(args[2]!))
				throw new Error("Usage: tau import activate <import-id>");
			const id = args[2]!;
			const receiptPath = join(importRoot(agentDir), "receipts", `${id}.json`);
			if (!existsSync(receiptPath)) throw new Error("Unknown import ID");
			const receipt = readObject(receiptPath);
			if (
				receipt.owner !== OWNER ||
				receipt.id !== id ||
				receipt.manifestSha256 !== id ||
				receipt.generationRelativePath !== generationPath(id)
			)
				throw new Error("Invalid import receipt");
			const manifest = validateGeneration(agentDir, generationPath(id), id);
			console.log(
				JSON.stringify({
					id,
					resources: manifest.resources.map(({ id, kind, path }) => ({ id, kind, path })),
					preferenceKeys: manifest.preferenceKeys,
				}),
			);
			await activatePiImport(id, agentDir);
			console.log(JSON.stringify({ id, status: "activated" }));
			return true;
		}
		if (args[1] !== "pi")
			throw new Error(
				"Usage: tau import pi [--from <agent-dir>] [--project <project-dir>] [--select <id> ...] [--preferences] [--on-conflict error|skip] [--apply --plan-hash <sha256>]",
			);
		const options: ImportOptions = {
			sourceAgentDir: join(homedir(), ".pi", "agent"),
			destinationAgentDir: agentDir,
			preferences: false,
			onConflict: "error",
		};
		const selected: string[] = [];
		const seen = new Set<string>();
		let apply = false;
		let planHash: string | undefined;
		for (let index = 2; index < args.length; index++) {
			const flag = args[index]!;
			if (flag !== "--select" && seen.has(flag)) throw new Error("Duplicate import option");
			seen.add(flag);
			if (flag === "--preferences") {
				options.preferences = true;
				continue;
			}
			if (flag === "--apply") {
				apply = true;
				continue;
			}
			if (!["--from", "--project", "--select", "--on-conflict", "--plan-hash"].includes(flag))
				throw new Error("Unknown import option");
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("Import option requires a value");
			if (flag === "--from") options.sourceAgentDir = value;
			else if (flag === "--project") options.sourceProjectDir = value;
			else if (flag === "--select") selected.push(value);
			else if (flag === "--on-conflict") {
				if (value !== "error" && value !== "skip") throw new Error("Invalid import conflict policy");
				options.onConflict = value;
			} else planHash = value;
		}
		if (selected.length) options.selectedIds = selected;
		if ((apply && (!planHash || !/^[a-f0-9]{64}$/.test(planHash))) || (!apply && planHash))
			throw new Error("Apply requires a reviewed --plan-hash; dry run does not accept one");
		const plan = await inventoryPiImport(options);
		if (!apply) {
			console.log(JSON.stringify(plan, null, 2));
			if (plan.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
			return true;
		}
		if (plan.id !== planHash) throw new Error("Import changed since review; obtain a new plan hash");
		if (plan.diagnostics.some((item) => item.severity === "error" && item.code !== "pending-journal"))
			throw new Error("Import inventory contains blocking diagnostics");
		console.log(JSON.stringify(await applyPiImport(plan)));
	} catch (error) {
		// Do not stringify arbitrary JSON parse or system errors: their messages can contain source content.
		const message =
			error instanceof Error &&
			/^(Usage: tau import|Unknown import|Invalid import|Duplicate import|Import option|Apply requires|Import changed|Import inventory|Import resource conflict|Import preference conflict|Activation.*conflict|Generation.*mismatch)/.test(
				error.message,
			)
				? error.message
				: "Pi import failed safely; inspect the content-free inventory diagnostics.";
		console.error(message);
		process.exitCode = 1;
	}
	return true;
}
