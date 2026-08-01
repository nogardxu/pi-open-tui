import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterSeparator, OpenTuiConfig } from "./config.ts";
import type { IconGlyphs } from "./icons.ts";
import { resolveGlyphs, runtimeSymbol } from "./icons.ts";
import type { GitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import {
	alignRight,
	cacheHitColor,
	effortColor,
	fitSegmentsByPriority,
	fmtTokens,
	formatContextWindow,
	formatCwd,
	sanitizeStatus,
	stressColor,
	truncatePath,
} from "./utils.ts";
import type { FooterState, ModelMeta, UsageTotals } from "./state.ts";
import { getUsageTotals } from "./state.ts";

function renderGitBranchSegment(
	theme: Theme,
	git: GitStatus,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
	maxBranchLen = 20,
): string {
	if (!segments.gitBranch) return "";
	if (git.branch) {
		return `${theme.fg("mdLink", glyphs.git)} ${theme.fg("mdLink", truncatePath(git.branch, maxBranchLen))}`;
	}
	if (!git.commit?.detached) return "";
	const hash = git.commit.oid ? ` ${theme.fg("dim", git.commit.oid.slice(0, 7))}` : "";
	const tag = git.commit.tag ? ` ${theme.fg("dim", git.commit.tag)}` : "";
	return `${theme.fg("warning", glyphs.git)} ${theme.fg("warning", "HEAD")}${hash}${tag}`;
}

function renderGitStatusSegment(
	theme: Theme,
	git: GitStatus,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
): string {
	if (!segments.gitStatus) return "";
	const statusIcons: string[] = [];
	// Always show counts so !1 and !100 remain distinguishable.
	const addStatus = (count: number, glyph: string, color: ThemeColor) => {
		if (count > 0) statusIcons.push(theme.fg(color, `${glyph}${count}`));
	};
	addStatus(git.conflicted, glyphs.conflicted, "error");
	addStatus(git.deleted, glyphs.deleted, "error");
	addStatus(git.modified, glyphs.modified, "warning");
	addStatus(git.renamed, glyphs.renamed, "warning");
	addStatus(git.staged, glyphs.staged, "success");
	addStatus(git.untracked, glyphs.untracked, "muted");
	addStatus(git.stashed, glyphs.stashed, "muted");
	if (git.ahead > 0 && git.behind > 0) {
		statusIcons.push(theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`));
	} else if (git.ahead > 0) {
		statusIcons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
	} else if (git.behind > 0) {
		statusIcons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
	}
	return statusIcons.length > 0
		? `${theme.fg("dim", "[")}${statusIcons.join(" ")}${theme.fg("dim", "]")}`
		: "";
}

function renderRuntimeSegment(
	theme: Theme,
	runtime: RuntimeInfo | null,
	iconMode: OpenTuiConfig["icons"]["mode"],
): string {
	if (!runtime) return "";
	const symbol = theme.fg("success", runtimeSymbol(runtime.name, iconMode));
	const version = runtime.version ? theme.fg("muted", runtime.version) : "";
	const label = [symbol, version].filter(Boolean).join(" ");
	return label;
}

function renderContextSegment(
	theme: Theme,
	ctx: ExtensionContext,
	glyphs: IconGlyphs,
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return "";
	const contextPct = contextUsage?.percent ?? 0;
	const pctText = theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`);
	const windowText = theme.fg("text", formatContextWindow(contextWindow));
	return `${theme.fg(stressColor(contextPct), glyphs.context)} ${pctText}${theme.fg("dim", "/")}${windowText}`;
}

function renderUsageSegments(
	theme: Theme,
	totals: UsageTotals,
	glyphs: IconGlyphs,
	segments: OpenTuiConfig["footerSegments"],
): string[] {
	const stats: string[] = [];
	if (segments.tokens) {
		stats.push(theme.fg("accent", `${glyphs.input} ${fmtTokens(totals.input)}`));
		stats.push(theme.fg("success", `${glyphs.output} ${fmtTokens(totals.output)}`));
		if (totals.cacheHitRate !== undefined) {
			stats.push(theme.fg(cacheHitColor(totals.cacheHitRate), `${glyphs.cacheHit} ${totals.cacheHitRate.toFixed(1)}%`));
		}
	}
	if (segments.cost) stats.push(theme.fg("warning", `${glyphs.cost} $${totals.cost.toFixed(3)}`));
	return stats;
}

function renderExtensionStatusSegment(
	theme: Theme,
	extensionStatuses: ReadonlyMap<string, string>,
	glyphs: IconGlyphs,
	separator: string,
): string {
	const statuses = Array.from(extensionStatuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text))
		.filter((text) => text.length > 0);
	if (statuses.length === 0) return "";
	return `${theme.fg("mdLink", glyphs.extensions)} ${statuses.map((status) => theme.fg("muted", status)).join(separator)}`;
}

function renderClockSegment(theme: Theme, glyphs: IconGlyphs): string {
	const now = new Date();
	const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
		.map((part) => part.toString().padStart(2, "0"))
		.join(":");
	return `${theme.fg("dim", glyphs.working)} ${theme.fg("text", time)}`;
}

function separatorFor(theme: Theme, separator: FooterSeparator): string {
	const text = {
		dot: " · ",
		pipe: " | ",
		slash: " / ",
		arrow: " → ",
	}[separator];
	return theme.fg("dim", text);
}

export interface FooterHooks {
	setRequestRender: (fn: (() => void) | undefined) => void;
	scheduleGitRefresh: () => void;
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => OpenTuiConfig,
	getModelMeta: () => ModelMeta,
	hooks: FooterHooks,
): () => void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender(() => tui.requestRender());
		const unsubBranch = footerData.onBranchChange(() => {
			hooks.scheduleGitRefresh();
			tui.requestRender();
		});
		const clockTimer = setInterval(() => tui.requestRender(), 1000);
		clockTimer.unref?.();
		return {
			dispose() {
				unsubBranch();
				clearInterval(clockTimer);
				hooks.setRequestRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const segments = config.footerSegments;
				const meta = getModelMeta();
				const separator = separatorFor(theme, config.footer.separator);
				const totals = getUsageTotals(ctx);

				const leftParts: { text: string; priority: number }[] = [];
				if (segments.cwd) {
					const maxCwd = Math.min(30, Math.max(10, Math.floor(width * 0.4)));
					leftParts.push({
						text: `${theme.fg("mdLink", glyphs.cwd)} ${theme.fg("accent", truncatePath(formatCwd(ctx.sessionManager.getCwd()), maxCwd))}`,
						priority: 6,
					});
				}
				leftParts.push({
					text: `${theme.fg("mdLink", glyphs.model)} ${theme.fg("text", meta.model)}`,
					priority: 6,
				});
				if (meta.effort && meta.effort !== "off") {
					leftParts.push({
						text: `${theme.fg(effortColor(meta.effort), glyphs.thinking)} ${theme.fg(effortColor(meta.effort), meta.effort)}`,
						priority: 5,
					});
				}
				const gitBranch = renderGitBranchSegment(theme, state.git, glyphs, segments);
				if (gitBranch) leftParts.push({ text: gitBranch, priority: 4 });
				const gitStatus = renderGitStatusSegment(theme, state.git, glyphs, segments);
				if (gitStatus) leftParts.push({ text: gitStatus, priority: 3 });
				if (segments.runtime) {
					const runtimeSeg = renderRuntimeSegment(theme, state.runtime, config.icons.mode);
					if (runtimeSeg) leftParts.push({ text: runtimeSeg, priority: 2 });
				}
				if (segments.extensionStatuses) {
					const extensionStatus = renderExtensionStatusSegment(theme, footerData.getExtensionStatuses(), glyphs, separator);
					if (extensionStatus) leftParts.push({ text: extensionStatus, priority: 0 });
				}

				const rightParts: { text: string; priority: number }[] = [];
				if (segments.context) {
					const context = renderContextSegment(theme, ctx, glyphs);
					if (context) rightParts.push({ text: context, priority: 6 });
				}
				for (const text of renderUsageSegments(theme, totals, glyphs, segments)) {
					rightParts.push({ text, priority: 4 });
				}
				rightParts.push({ text: renderClockSegment(theme, glyphs), priority: 6 });

				const rightBlock = fitSegmentsByPriority(rightParts, width, theme.fg("dim", "..."), separator).join(separator);
				const rightW = visibleWidth(rightBlock);
				const availLeft = Math.max(0, width - rightW - (rightBlock ? 1 : 0));
				const fittedLeft = fitSegmentsByPriority(leftParts, availLeft, theme.fg("dim", "..."), separator).join(separator);
				const line = alignRight(fittedLeft, rightBlock, width, theme);
				return [truncateToWidth(line, width, theme.fg("dim", "..."))];
			},
		};
	});

	return () => {
		ctx.ui.setFooter(undefined);
	};
}
