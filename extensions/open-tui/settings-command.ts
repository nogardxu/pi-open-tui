import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type TUI,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	GIT_STATUS_REFRESH_INTERVALS_MS,
	type FooterSeparator,
	type IconMode,
	type OpenTuiConfig,
} from "./config.ts";

interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
}

type Tab = "general" | "segments" | "telemetry";

const TABS: Tab[] = ["general", "segments", "telemetry"];

const COPY = {
	title: "Open TUI Settings",
	tabs: { general: "General", segments: "Footer", telemetry: "Telemetry" },
	hint: "Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close",
	labels: {
		enabled: "Enabled",
		model: "Model",
		thinking: "Thinking level",
		iconMode: "Icon mode",
		separator: "Footer separator",
		gitStatusRefresh: "Git status refresh",
		clock: "Clock",
		cwd: "CWD",
		gitBranch: "Git branch",
		gitStatus: "Git status",
		gitCommit: "Git commit (detached)",
		runtime: "Runtime",
		context: "Context bar",
		tokens: "Tokens",
		cost: "Cost",
		extensionStatuses: "Extension status line",
		totalDuration: "Total duration",
		inputTokens: "Input tokens",
		outputTokens: "Output tokens",
		cacheRate: "Cache hit rate",
		costRate: "Cost",
	},
	values: {
		on: "On",
		off: "Off",
		icons: { auto: "Auto", nerd: "Nerd", ascii: "ASCII" },
		separators: { dot: "Dot", pipe: "Pipe", slash: "Slash", arrow: "Arrow" },
	},
} as const;

type SettingsCopy = typeof COPY;

function toggleSetting(config: OpenTuiConfig, key: keyof OpenTuiConfig["footerSegments"]): OpenTuiConfig {
	return {
		...config,
		footerSegments: {
			...config.footerSegments,
			[key]: !config.footerSegments[key],
		},
	};
}

function cycleIconMode(config: OpenTuiConfig): OpenTuiConfig {
	const order: IconMode[] = ["auto", "nerd", "ascii"];
	const currentIdx = order.indexOf(config.icons.mode);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, icons: { mode: next } };
}

function cycleFooterSeparator(config: OpenTuiConfig): OpenTuiConfig {
	const order: FooterSeparator[] = ["dot", "pipe", "slash", "arrow"];
	const currentIdx = order.indexOf(config.footer.separator);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, footer: { separator: next } };
}

function cycleGitStatusRefresh(config: OpenTuiConfig): OpenTuiConfig {
	const currentIndex = GIT_STATUS_REFRESH_INTERVALS_MS.indexOf(
		config.git.statusRefreshIntervalMs as typeof GIT_STATUS_REFRESH_INTERVALS_MS[number],
	);
	const nextIndex = currentIndex < 0
		? 0
		: (currentIndex + 1) % GIT_STATUS_REFRESH_INTERVALS_MS.length;
	return {
		...config,
		git: { statusRefreshIntervalMs: GIT_STATUS_REFRESH_INTERVALS_MS[nextIndex]! },
	};
}

function formatInterval(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${ms / 1_000}s`;
}

function toggleEnabled(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, enabled: !config.enabled };
}

function toggleTelemetry(config: OpenTuiConfig, key: keyof OpenTuiConfig["telemetry"]): OpenTuiConfig {
	return {
		...config,
		telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
	};
}

function buildGeneralItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: config.enabled ? copy.values.on : copy.values.off },
		{ id: "mode", label: copy.labels.iconMode, currentValue: copy.values.icons[config.icons.mode] },
	];
}

function buildSegmentsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const segs = config.footerSegments;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "cwd", label: copy.labels.cwd, currentValue: flag(segs.cwd) },
		{ id: "model", label: copy.labels.model, currentValue: flag(segs.model) },
		{ id: "thinking", label: copy.labels.thinking, currentValue: flag(segs.thinking) },
		{ id: "gitBranch", label: copy.labels.gitBranch, currentValue: flag(segs.gitBranch) },
		{ id: "gitStatus", label: copy.labels.gitStatus, currentValue: flag(segs.gitStatus) },
		{ id: "gitCommit", label: copy.labels.gitCommit, currentValue: flag(segs.gitCommit) },
		{ id: "runtime", label: copy.labels.runtime, currentValue: flag(segs.runtime) },
		{ id: "context", label: copy.labels.context, currentValue: flag(segs.context) },
		{ id: "tokens", label: copy.labels.tokens, currentValue: flag(segs.tokens) },
		{ id: "cost", label: copy.labels.cost, currentValue: flag(segs.cost) },
		{ id: "extensionStatuses", label: copy.labels.extensionStatuses, currentValue: flag(segs.extensionStatuses) },
		{ id: "clock", label: copy.labels.clock, currentValue: flag(segs.clock) },
		{ id: "separator", label: copy.labels.separator, currentValue: copy.values.separators[config.footer.separator] },
		{ id: "gitStatusRefresh", label: copy.labels.gitStatusRefresh, currentValue: formatInterval(config.git.statusRefreshIntervalMs) },
	];
}

function buildTelemetryItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const telemetry = config.telemetry;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: flag(telemetry.enabled) },
		{ id: "timestamp", label: "Timestamp", currentValue: flag(telemetry.timestamp) },
		{ id: "inputTokens", label: copy.labels.inputTokens, currentValue: flag(telemetry.inputTokens) },
		{ id: "outputTokens", label: copy.labels.outputTokens, currentValue: flag(telemetry.outputTokens) },
		{ id: "cacheRate", label: copy.labels.cacheRate, currentValue: flag(telemetry.cacheRate) },
		{ id: "cost", label: copy.labels.costRate, currentValue: flag(telemetry.cost) },
		{ id: "duration", label: copy.labels.totalDuration, currentValue: flag(telemetry.duration) },
		{ id: "tps", label: "TPS", currentValue: flag(telemetry.tps) },
		{ id: "ttft", label: "TTFT", currentValue: flag(telemetry.ttft) },
	];
}

function buildItems(tab: Tab, config: OpenTuiConfig): SettingItem[] {
	const copy = COPY;
	switch (tab) {
		case "general": return buildGeneralItems(config, copy);
		case "segments": return buildSegmentsItems(config, copy);
		case "telemetry": return buildTelemetryItems(config, copy);
	}
}

function handleSettingChange(
	tab: Tab,
	itemId: string,
	config: OpenTuiConfig,
): OpenTuiConfig {
	if (tab === "general") {
		if (itemId === "enabled") return toggleEnabled(config);
		if (itemId === "mode") return cycleIconMode(config);
	}
	if (tab === "segments" && itemId === "separator") return cycleFooterSeparator(config);
	if (tab === "segments" && itemId === "gitStatusRefresh") return cycleGitStatusRefresh(config);
	if (tab === "segments") {
		return toggleSetting(config, itemId as keyof OpenTuiConfig["footerSegments"]);
	}
	if (tab === "telemetry") {
		return toggleTelemetry(config, itemId as keyof OpenTuiConfig["telemetry"]);
	}
	return config;
}

interface SettingsUiHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

class SettingsDivider {
	private readonly paint: (text: string) => string;

	constructor(paint: (text: string) => string) {
		this.paint = paint;
	}

	render(width: number): string[] {
		return [this.paint("─".repeat(Math.max(0, width)))];
	}

	invalidate(): void {}
}

class SettingsSpacer {
	private height = 0;

	setHeight(height: number): void {
		this.height = Math.max(0, height);
	}

	render(width: number): string[] {
		return Array.from({ length: this.height }, () => " ".repeat(Math.max(0, width)));
	}

	invalidate(): void {}
}

class SettingsUi implements SettingsUiHandle {
	private tab: Tab = "general";
	private config: OpenTuiConfig;
	private selectList: SelectList;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private readonly container: Box;
	private readonly headerSpacer = new SettingsSpacer();
	private readonly contentSpacer = new SettingsSpacer();
	private readonly theme: Theme;
	private readonly onChange: (config: OpenTuiConfig) => void;
	private readonly onClose: () => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private compact = false;

	constructor(
		theme: Theme,
		config: OpenTuiConfig,
		onChange: (config: OpenTuiConfig) => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.config = config;
		this.onChange = onChange;
		this.onClose = onClose;
		this.headerSpacer.setHeight(1);
		this.container = new Box(1, 0, (s: string) => theme.bg("customMessageBg", s));
		this.selectList = new SelectList([], 12, {
			selectedPrefix: (t) => theme.bold(theme.fg("accent", t)),
			selectedText: (t) => theme.bold(theme.fg("accent", t)),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.rebuild();
	}

	private applySetting(itemId: string): void {
		this.selectedItemByTab[this.tab] = itemId;
		this.config = handleSettingChange(this.tab, itemId, this.config);
		this.onChange(this.config);
		this.rebuild(itemId);
	}

	private switchTab(offset: number): void {
		const idx = TABS.indexOf(this.tab);
		this.tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
		this.rebuild();
	}

	private buildTabBar(tab: Tab): string {
		return TABS.map((candidate) => {
			const active = candidate === tab;
			const label = ` ${COPY.tabs[candidate]} `;
			return active ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.fg("dim", label);
		}).join(" ");
	}

	private buildSelectItems(tab: Tab): SelectItem[] {
		return buildItems(tab, this.config).map((item) => ({
			value: item.id,
			label: this.compact ? `${item.label}: ${item.currentValue}` : item.label,
			description: this.compact ? undefined : item.currentValue,
		} as SelectItem));
	}

	private createSelectList(items: SelectItem[]): SelectList {
		return new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => this.theme.bold(this.theme.fg("accent", t)),
			selectedText: (t) => this.theme.bold(this.theme.fg("accent", t)),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
	}

	private measureContainerHeight(width: number): number {
		const innerWidth = Math.max(1, width - 2);
		const childWidth = Math.max(1, innerWidth - 2);
		const hint = new Text(this.theme.fg("dim", COPY.hint), 1, 0);
		let maxChildLines = 0;

		for (const tab of TABS) {
			const tabLines = new Text(this.buildTabBar(tab), 1, 0).render(childWidth).length;
			const selectLines = this.createSelectList(this.buildSelectItems(tab)).render(childWidth).length;
			const hintLines = hint.render(childWidth).length;
			maxChildLines = Math.max(maxChildLines, tabLines + 1 + selectLines + 1 + hintLines);
		}

		return maxChildLines + 1;
	}

	private rebuild(preferredItemId = this.selectedItemByTab[this.tab]): void {
		this.container.clear();
		this.container.addChild(this.headerSpacer);
		this.container.addChild(new Text(this.buildTabBar(this.tab), 1, 0));
		this.container.addChild(new SettingsDivider((text) => this.theme.fg("accent", text)));

		const items = this.buildSelectItems(this.tab);
		this.selectList = this.createSelectList(items);
		const selectedIndex = items.findIndex((item) => item.value === preferredItemId);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
		}
		this.selectedItemByTab[this.tab] = this.selectList.getSelectedItem()?.value;
		this.selectList.onSelectionChange = (item) => {
			this.selectedItemByTab[this.tab] = item.value;
		};
		this.selectList.onSelect = (item) => {
			this.applySetting(item.value);
		};
		this.selectList.onCancel = () => {
			this.onClose();
		};
		this.container.addChild(this.selectList);
		this.container.addChild(this.contentSpacer);
		this.container.addChild(new SettingsDivider((text) => this.theme.fg("accent", text)));
		this.container.addChild(new Text(this.theme.fg("dim", COPY.hint), 1, 0));

		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(-1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.space) || data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.applySetting(selected.value);
		} else {
			this.selectList.handleInput?.(data);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const compact = width <= 60;
		if (compact !== this.compact) {
			this.compact = compact;
			this.rebuild();
		}
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		if (width <= 2) {
			this.cachedLines = this.container.render(Math.max(1, width)).map((line) => truncateToWidth(line, width, ""));
			return this.cachedLines;
		}

		const innerWidth = width - 2;
		this.contentSpacer.setHeight(0);
		this.container.invalidate();
		const baseContentLines = this.container.render(innerWidth);
		const fixedContentHeight = this.measureContainerHeight(width);
		this.contentSpacer.setHeight(fixedContentHeight - baseContentLines.length);
		this.container.invalidate();
		const contentLines = this.container.render(innerWidth);
		const border = (text: string) => this.theme.fg("accent", text);
		const title = `─ ${this.theme.bold(this.theme.fg("accent", COPY.title))} `;
		const top = visibleWidth(title) >= innerWidth
			? `${border("╭")}${truncateToWidth(title, innerWidth, "")}${border("╮")}`
			: `${border("╭")}${title}${border("─".repeat(innerWidth - visibleWidth(title)))}${border("╮")}`;
		const body = contentLines.map((line) =>
			`${border("│")}${truncateToWidth(line, innerWidth, "", true)}${border("│")}`,
		);
		const bottom = `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`;
		this.cachedLines = [top, ...body, bottom];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.container.invalidate();
	}
}

export function registerSettingsCommand(
	pi: ExtensionAPI,
	hooks: {
		getConfig: () => OpenTuiConfig;
		onConfigChanged: (config: OpenTuiConfig) => void;
	},
): void {
	pi.registerCommand("open-tui", {
		description: "Open the open-tui settings UI",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((tui: TUI, theme, _kb, done) => {
			const ui = new SettingsUi(
				theme,
				hooks.getConfig(),
				(config) => hooks.onConfigChanged(config),
				() => done(undefined),
			);
			return {
				render: (w: number) => ui.render(w),
				invalidate: () => ui.invalidate(),
				handleInput: (data: string) => {
					ui.handleInput(data);
					tui.requestRender();
				},
			};
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				margin: { top: 1, right: 1, bottom: 1, left: 1 },
			},
		});
		},
	});
}
