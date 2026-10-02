#!/usr/bin/env node
import { launchTau } from "./core/isolation/launcher.ts";

launchTau(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Tau launch failed");
		process.exitCode = 1;
	});
