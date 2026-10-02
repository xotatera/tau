import { beforeAll, describe, expect, test } from "vitest";
import { APP_TITLE } from "../src/config.ts";
import { type EasterEgg3dAnimation, playEasterEgg3d } from "../src/modes/interactive/components/easter-egg-3d.ts";
import { tauLogoLines, tauWordmark } from "../src/modes/interactive/components/tau-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Tau display branding", () => {
	beforeAll(() => initTheme("dark"));
	test("uses the Tau symbol for terminal titles", () => {
		expect(APP_TITLE).toBe("τ");
	});

	test("uses the Tau symbol for the startup wordmark fallback", () => {
		expect(stripAnsi(tauWordmark())).toBe("τ");
	});

	test("draws a four-column τ in the terminal startup header", () => {
		expect(tauLogoLines().map(stripAnsi)).toEqual(["▀▀▀▀", " ▀▀ "]);
	});

	test("the clickable 3D logo uses the same τ silhouette", async () => {
		let animation: EasterEgg3dAnimation | undefined;
		const tui = {
			queryTerminalColors: async () => ({}),
			hasOverlay: () => false,
			showOverlay(component: EasterEgg3dAnimation) {
				animation = component;
				return { hide() {} };
			},
			requestRender() {},
		};
		await playEasterEgg3d(tui as never, [], { kind: "tau-logo", column: 1, row: 1 } as never);
		const model = (animation as unknown as { model: { blocks: Array<{ home: [number, number, number] }> } }).model;
		const pixels = model.blocks.map(({ home: [x, y] }) => `${x},${y}`);
		expect(pixels).toEqual(["0,0", "1,0", "2,0", "3,0", "1,1", "2,1", "1,2", "2,2", "1,3", "2,3"]);
		animation?.close();
		animation?.close();
	});
});
