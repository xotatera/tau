// Bun compiled artifacts have no independently addressable sandbox runtime entry.
// This module must evaluate before runtime setup or any extension-capable module.
const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (
	args
		.slice(0, separator < 0 ? undefined : separator)
		.some((arg) => arg === "--isolated" || arg.startsWith("--sandbox-"))
) {
	console.error("Isolation requires the Linux Node distribution; Bun isolation is unsupported");
	process.exit(1);
}
