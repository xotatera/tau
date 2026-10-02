import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.TAU_CODING_AGENT = "true";
	// Keep the marker understood by existing Pi-aware integrations; it is not a state path.
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = APP_NAME;
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
