import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import { registerSettingsCommand } from "../extensions/open-tui/settings-command.ts";

interface SettingsComponent extends Component {
	handleInput(data: string): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

async function openSettings(initialConfig = structuredClone(DEFAULT_CONFIG)): Promise<{
	component: SettingsComponent;
	getConfig: () => OpenTuiConfig;
	isClosed: () => boolean;
}> {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = initialConfig;
	let closed = false;

	const pi = {
		registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (nextConfig) => {
			config = nextConfig;
		},
	});

	const tui = { requestRender() {} } as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => Component,
			) => {
				component = factory(tui, theme, {} as KeybindingsManager, (_value: void) => {
					closed = true;
				}) as SettingsComponent;
			},
		},
	} as unknown as ExtensionContext;

	assert.ok(commandHandler);
	await commandHandler("", ctx);
	assert.ok(component);

	return { component, getConfig: () => config, isClosed: () => closed };
}

function selectedLine(component: SettingsComponent): string {
	return component.render(80).find((line) => line.includes("→ ")) ?? "";
}

test("keeps the changed setting selected", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	for (let i = 0; i < 3; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Git branch/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.gitBranch, false);
	assert.match(selectedLine(settings.component), /Git branch/);
});

test("remembers the selection for each tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	for (let i = 0; i < 3; i++) settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");

	assert.match(selectedLine(settings.component), /Git branch/);
});

test("configures telemetry from its own tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	assert.match(selectedLine(settings.component), /Enabled/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.enabled, false);
	for (let i = 0; i < 7; i++) settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.tps, false);
});

test("renders a framed English settings dialog with merged general controls", async () => {
	const settings = await openSettings();
	const lines = settings.component.render(80);
	const output = lines.join("\n");

	assert.equal(visibleWidth(lines[0]!), 80);
	assert.equal(visibleWidth(lines.at(-1)!), 80);
	assert.match(lines[0]!, /^╭/);
	assert.match(lines[1]!, /^│\s+│$/);
	assert.match(lines[2]!, /General/);
	assert.match(lines.at(-1)!, /^╰/);
	assert.match(output, /Open TUI Settings.*General.*Icon mode/s);
	assert.match(output, /Footer.*Telemetry/s);
	assert.match(output, /─/);
	assert.doesNotMatch(output, /Language|\[General\]|\[Icons\]|简体中文/);

	settings.component.handleInput("\x1b[B");
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().icons.mode, "nerd");
	settings.component.handleInput("q");
	assert.equal(settings.isClosed(), true);
});

test("keeps the dialog height stable when switching tabs", async () => {
	for (const width of [80, 48, 24]) {
		const settings = await openSettings();
		const heights = [settings.component.render(width).length];
		settings.component.handleInput("\t");
		heights.push(settings.component.render(width).length);
		settings.component.handleInput("\t");
		heights.push(settings.component.render(width).length);
		assert.equal(new Set(heights).size, 1, `${width}: ${heights.join(", ")}`);
		assert.match(settings.component.render(width).at(-2)!, /close/);
	}
});

test("configures the extension status line with Space", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 10; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Extension status line/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.extensionStatuses, false);
	assert.match(selectedLine(settings.component), /Extension status line/);
});

test("cycles the footer separator from the Footer tab", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 12; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Footer separator/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footer.separator, "pipe");
	assert.match(selectedLine(settings.component), /Pipe/);
});

test("cycles the Git status refresh interval from the Footer tab", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 13; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Git status refresh/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().git.statusRefreshIntervalMs, 60_000);
	assert.match(selectedLine(settings.component), /1m/);
});

test("keeps the framed English dialog within narrow widths", async () => {
	const settings = await openSettings();

	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		}
		const output = lines.join("\n");
		assert.match(output, /On/);
		assert.match(output, /Auto/);
		assert.doesNotMatch(output, /Language|简体中文/);
	}
});

test("drops the removed language setting from older config files", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ settingsLanguage: "zh" }), "utf8");
		assert.equal("settingsLanguage" in loadConfig(), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("splits the legacy telemetry token setting", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ telemetry: { tokens: false } }), "utf8");
		const config = loadConfig();
		assert.equal(config.telemetry.inputTokens, false);
		assert.equal(config.telemetry.outputTokens, false);
		assert.equal(config.telemetry.cacheRate, false);
		assert.equal("tokens" in config.telemetry, false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
