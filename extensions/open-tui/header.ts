import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { formatCwd, formatModelLabel, padRight, stripAnsi, truncateToWidth, visibleWidth } from "./utils.ts";

const RECENT_SESSION_LIMIT = 5;
const COLUMN_GAP = 3;
const SESSION_REFRESH_MS = 60_000;

function maxWidth(lines: readonly string[]): number {
	return lines.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
}

function formatSessionAge(date: Date, now = Date.now()): string {
	const diffMs = Math.max(0, now - date.getTime());
	const diffMinutes = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffMinutes < 1) return "now";
	if (diffMinutes < 60) return `${diffMinutes}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function sessionTitle(session: SessionInfo): string {
	const raw = session.name || session.firstMessage || "Untitled session";
	const normalized = stripAnsi(raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return normalized || "Untitled session";
}

function sessionLine(
	session: SessionInfo,
	width: number,
	muted: (text: string) => string,
	dim: (text: string) => string,
): string {
	const age = formatSessionAge(session.modified);
	const suffix = ` ${age}`;
	const titleWidth = Math.max(8, width - visibleWidth(suffix) - 2);
	const title = truncateToWidth(`  ${sessionTitle(session)}`, titleWidth, "...");
	return `${muted(title)}${dim(suffix)}`;
}

function renderStacked(
	leftLines: readonly string[],
	rightLines: readonly string[],
	width: number,
): string[] {
	return [...leftLines, "", ...rightLines].map((line) => truncateToWidth(line, width, "..."));
}

function renderColumns(
	leftLines: readonly string[],
	rightLines: readonly string[],
	width: number,
): string[] {
	const leftWidth = maxWidth(leftLines);
	const rightWidth = maxWidth(rightLines);
	if (leftWidth + COLUMN_GAP + rightWidth > width) {
		return renderStacked(leftLines, rightLines, width);
	}

	const lines: string[] = [];
	const lineCount = Math.max(leftLines.length, rightLines.length);
	for (let i = 0; i < lineCount; i++) {
		const left = padRight(leftLines[i] ?? "", leftWidth);
		const right = rightLines[i] ?? "";
		lines.push(right ? `${left}${" ".repeat(COLUMN_GAP)}${right}` : left.trimEnd());
	}
	return lines;
}

export class OpenTuiHeader implements Component {
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly tui: TUI;
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private recentSessions: SessionInfo[] = [];
	private sessionsLoading = true;
	private disposed = false;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, tui: TUI) {
		this.pi = pi;
		this.ctx = ctx;
		this.tui = tui;
		this.refreshTimer = setInterval(() => {
			void this.loadRecentSessions();
		}, SESSION_REFRESH_MS);
		this.refreshTimer.unref?.();
		void this.loadRecentSessions();
	}

	private async loadRecentSessions(): Promise<void> {
		try {
			const sessions = await SessionManager.list(
				this.ctx.cwd,
				this.ctx.sessionManager.getSessionDir(),
			);
			if (this.disposed) return;
			this.recentSessions = sessions
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, RECENT_SESSION_LIMIT);
		} catch {
			if (!this.disposed) this.recentSessions = [];
		} finally {
			if (!this.disposed) {
				this.sessionsLoading = false;
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const accent = (text: string) => theme.fg("accent", text);
		const muted = (text: string) => theme.fg("muted", text);
		const dim = (text: string) => theme.fg("dim", text);
		const bold = (text: string) => theme.bold(text);

		if (width <= 0) return [""];

		const model = formatModelLabel(this.ctx.model);
		const cwd = formatCwd(this.ctx.cwd);
		const skills = this.pi.getCommands().filter((command) => command.source === "skill").length;
		const tools = this.pi.getAllTools().length;

		const leftLines = [bold(model), dim(cwd)];
		const rightLines = [
			accent(bold("Loaded")),
			muted(`  Skills: ${skills}`),
			muted(`  Tools: ${tools}`),
			"",
			accent(bold("Recent Session")),
		];

		const rightWidth = Math.max(20, Math.min(48, width));
		if (this.sessionsLoading) {
			rightLines.push(muted("  Loading..."));
		} else if (this.recentSessions.length === 0) {
			rightLines.push(muted("  None"));
		} else {
			for (const session of this.recentSessions) {
				rightLines.push(sessionLine(session, rightWidth, muted, dim));
			}
		}

		return renderColumns(leftLines, rightLines, width);
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.refreshTimer);
		this.recentSessions = [];
	}
}

export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext): () => void {
	let header: OpenTuiHeader | undefined;
	ctx.ui.setHeader((tui) => {
		header?.dispose();
		header = new OpenTuiHeader(pi, ctx, tui);
		return header;
	});
	return () => {
		header?.dispose();
		header = undefined;
		ctx.ui.setHeader(undefined);
	};
}
