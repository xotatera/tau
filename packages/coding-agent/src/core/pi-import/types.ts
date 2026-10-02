export type ImportKind = "extension" | "skill" | "prompt" | "theme" | "package";
export type ConflictPolicy = "error" | "skip";
export interface ImportOptions {
	sourceAgentDir: string;
	sourceProjectDir?: string;
	destinationAgentDir: string;
	selectedIds?: readonly string[];
	preferences: boolean;
	onConflict: ConflictPolicy;
}
export interface ImportDiagnostic {
	code: string;
	resourceId?: string;
	severity: "warning" | "error";
	message: string;
}
export interface ImportResource {
	id: string;
	kind: ImportKind;
	sourceRoot: string;
	relativePath: string;
	sha256: string;
	fileCount: number;
	byteCount: number;
	destinationRelativePath: string;
	declaredSource?: string;
	resolvedVersion?: string;
	resolvedCommit?: string;
}
export interface ImportPlan {
	schemaVersion: 1;
	id: string;
	options: ImportOptions;
	resources: readonly ImportResource[];
	diagnostics: readonly ImportDiagnostic[];
	baseSettingsSha256: string;
}
export interface StagedImport {
	planId: string;
	stagingDir: string;
	generationRelativePath: string;
	manifestSha256: string;
}
export interface ImportReceipt {
	id: string;
	generationRelativePath: string;
	status: "inactive" | "already-imported";
	manifestSha256: string;
}
export interface SnapshotFile {
	path: string;
	sha256: string;
	byteCount: number;
	mode: number;
}
export type ImportPreferences = Partial<
	Record<"defaultProvider" | "defaultModel" | "defaultThinkingLevel" | "theme", string>
>;
export interface GenerationManifest {
	schemaVersion: 1;
	resources: Array<{
		id: string;
		kind: ImportKind;
		name: string;
		path: string;
		directory: boolean;
		files: SnapshotFile[];
	}>;
	preferenceKeys: Array<keyof ImportPreferences>;
	preferencesSha256: string;
}
export type JournalState = "staged" | "generation-published" | "settings-prepared" | "settings-published" | "complete";
