import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

export default function extension(pi: ExtensionAPI): void {
	const parameters = Type.Object({});
	pi.registerTool({
		name: "compat_probe",
		label: "Compatibility probe",
		description: "Exercise public host imports without calling a provider",
		parameters,
		async execute() {
			return {
				content: [{ type: "text", text: "compatible" }],
				details: {
					hostSessionManager: SessionManager,
					Agent,
					Text,
					getModel,
					compiled: Compile(parameters).Check({}),
					validated: Value.Check(parameters, {}),
				},
			};
		},
	});
	pi.registerCommand("compat-command", { description: "Legacy command", handler: async () => {} });
	pi.registerFlag("compat-flag", { type: "boolean", default: true });
	pi.registerShortcut("ctrl+shift+j", { description: "Legacy shortcut", handler: async () => {} });
	pi.registerMessageRenderer("compat-message", () => new Text("legacy message", 0, 0));
	pi.registerEntryRenderer("compat-entry", () => new Text("legacy entry", 0, 0));
	pi.registerProvider("compat-provider", { baseUrl: "http://127.0.0.1:1", models: [] });
}
