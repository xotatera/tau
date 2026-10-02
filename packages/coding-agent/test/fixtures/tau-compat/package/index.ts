import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("legacy-package", { description: "Legacy manifest entry", handler: async () => {} });
}
