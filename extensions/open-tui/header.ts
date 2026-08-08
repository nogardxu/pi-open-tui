import {
	SessionManager,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	center,
	formatCwd,
	formatModelLabel,
	padRight,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";

const RECENT_SESSION_LIMIT = 5;
const COLUMN_GAP = 3;
const SESSION_REFRESH_MS = 60_000;
const LEFT_COLUMN_WIDTH = 24;
const MIN_RIGHT_WIDTH = 14;
const MIN_FRAME_WIDTH = 48;
const MIN_HEADER_WIDTH = 24;

const LOGO_CELL = "███";

type LogoColor = "panel" | "cyan" | "red" | "green" | "orange" | "white" | "flash" | "brand";
type LogoFrame = { phase: number; active: "left" | "top" | "right" | "none"; ax: number; ay: number; flash: boolean; white: boolean };

const LOGO_FRAMES: LogoFrame[] = [
	...Array.from({ length: 4 }, (_, ay) => ({ phase: 0, active: "left" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 3 }, (_, ay) => ({ phase: 1, active: "top" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 5 }, (_, ay) => ({ phase: 2, active: "right" as const, ax: 5, ay, flash: false, white: false })),
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 4, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 6, active: "none", ax: 0, ay: 0, flash: false, white: false },
];

function hasCell(y: number, x: number, cells: string): boolean {
	return cells.split(" ").includes(`${y},${x}`);
}

function hasPiece(y: number, x: number, py: number, px: number, cells: string): boolean {
	return cells.split(" ").some((item) => {
		const [dy, dx] = item.split(",").map(Number);
		return y === py + dy && x === px + dx;
	});
}

function logoCellColor(frame: LogoFrame, y: number, x: number): LogoColor {
	if (frame.white) {
		return hasCell(y, x, "3,2 3,3 3,4 4,2 4,4 5,2 5,3 5,5 6,2 6,5") ? "white" : "panel";
	}
	if (frame.flash && y === 6 && x >= 1 && x <= 6) return "flash";

	switch (frame.active) {
		case "left":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 1,1 2,0")) return "red";
			break;
		case "top":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 0,1 0,2 1,2")) return "cyan";
			break;
		case "right":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 2,0 2,1")) return "green";
			break;
	}

	if (frame.phase === 6) {
		return hasCell(y, x, "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5") ? "brand" : "panel";
	}
	if (frame.phase === 4) {
		if (hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
		if (hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
		if (hasCell(y, x, "4,5 5,5")) return "green";
		return "panel";
	}
	if (frame.phase >= 5) {
		if (hasCell(y, x, "3,2 3,3 3,4 4,4")) return "cyan";
		if (hasCell(y, x, "4,2 5,2 5,3 6,2")) return "red";
		if (hasCell(y, x, "5,5 6,5")) return "green";
		return "panel";
	}
	if (frame.phase <= 3 && hasCell(y, x, "6,1 6,2 6,3 6,4")) return "orange";
	if (frame.phase >= 2 && hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
	if (frame.phase >= 1 && hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
	if (frame.phase >= 3 && hasCell(y, x, "4,5 5,5 6,5 6,6")) return "green";
	return "panel";
}

function colorCell(color: LogoColor, paintBrand: (text: string) => string): string {
	switch (color) {
		case "cyan": return `\x1b[36m${LOGO_CELL}\x1b[39m`;
		case "red": return `\x1b[31m${LOGO_CELL}\x1b[39m`;
		case "green": return `\x1b[32m${LOGO_CELL}\x1b[39m`;
		case "orange":
		case "flash": return `\x1b[33m${LOGO_CELL}\x1b[39m`;
		case "white": return `\x1b[39m${LOGO_CELL}`;
		case "brand": return paintBrand(LOGO_CELL);
		default: return " ".repeat(LOGO_CELL.length);
	}
}

function renderLogo(frameIndex: number, paintBrand: (text: string) => string): string[] {
	const frame = LOGO_FRAMES[frameIndex % LOGO_FRAMES.length]!;
	const grid: LogoColor[][] = [];
	for (let y = 1; y <= 7; y++) {
		const row: LogoColor[] = [];
		for (let x = 1; x <= 8; x++) row.push(logoCellColor(frame, y, x));
		grid.push(row);
	}

	let minX = 7;
	let maxX = 0;
	for (const row of grid) {
		row.forEach((cell, x) => {
			if (cell !== "panel") {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
		});
	}
	if (maxX < minX) { minX = 0; maxX = 7; }

	return grid.map((row) => {
		let line = "";
		for (let x = minX; x <= maxX; x++) line += colorCell(row[x]!, paintBrand);
		return line;
	});
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
	const titleWidth = Math.max(1, width - visibleWidth(suffix));
	const title = padRight(
		truncateToWidth(sessionTitle(session), titleWidth, "..."),
		titleWidth,
	);
	return `${muted(title)}${dim(suffix)}`;
}

function borderLine(
	left: string,
	label: string,
	right: string,
	width: number,
	paint: (text: string) => string,
): string {
	if (width <= 1) return "";
	if (width < 8 || label.length === 0) {
		return paint(truncateToWidth(left + "─".repeat(Math.max(0, width - 2)) + right, width, ""));
	}

	const before = "─── ";
	const after = " ─────";
	const fixedWidth = visibleWidth(before) + visibleWidth(label) + visibleWidth(after);
	const fill = Math.max(0, width - 2 - fixedWidth);
	return `${paint(left)}${paint(before)}${label}${paint(after)}${paint("─".repeat(fill))}${paint(right)}`;
}

function boxedLine(content: string, width: number, paint: (text: string) => string): string {
	if (width <= 2) return truncateToWidth(content, width, "");
	return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
}

function twoColumn(
	left: string,
	right: string,
	leftWidth: number,
	rightWidth: number,
	paint: (text: string) => string,
): string {
	const leftText = padRight(left, leftWidth);
	const rightText = truncateToWidth(right, rightWidth, "...");
	return `${leftText}${" ".repeat(COLUMN_GAP - 2)}${paint("│")}${" "}${rightText}`;
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
		const paint = (text: string) => theme.fg("accent", text);
		const muted = (text: string) => theme.fg("muted", text);
		const dim = (text: string) => theme.fg("dim", text);
		const bold = (text: string) => theme.bold(text);

		if (width <= 0) return [""];
		if (width < MIN_HEADER_WIDTH) return [paint(`Pi v${VERSION}`)];

		const model = formatModelLabel(this.ctx.model);
		const cwd = formatCwd(this.ctx.cwd);
		const skills = this.pi.getCommands().filter((command) => command.source === "skill").length;
		const tools = this.pi.getAllTools().length;

		const leftLines = [
			...renderLogo(LOGO_FRAMES.length - 1, paint),
			bold(model),
			dim(cwd),
		];
		const rightLines = [
			paint(bold("Loaded")),
			muted(`Skills: ${skills}`),
			muted(`Tools: ${tools}`),
			"",
			paint(bold("Recent Sessions")),
		];

		const frameWidth = Math.min(width, Math.max(MIN_FRAME_WIDTH, Math.round(width * 0.4)));
		const availableColumns = frameWidth - 2 - COLUMN_GAP;
		if (availableColumns < MIN_RIGHT_WIDTH + 12) {
			const singleWidth = Math.min(width, Math.max(MIN_HEADER_WIDTH, frameWidth));
			const lines = [borderLine("╭", `${paint("Pi")} v${VERSION}`, "╮", singleWidth, paint)];
			for (const line of leftLines) lines.push(boxedLine(center(line, singleWidth - 2), singleWidth, paint));
			lines.push(borderLine("╰", "", "╯", singleWidth, paint));
			return lines;
		}

		const leftWidth = Math.min(LEFT_COLUMN_WIDTH, availableColumns - MIN_RIGHT_WIDTH);
		const rightWidth = availableColumns - leftWidth;
		if (this.sessionsLoading) {
			rightLines.push(muted("Loading..."));
		} else if (this.recentSessions.length === 0) {
			rightLines.push(muted("None"));
		} else {
			for (const session of this.recentSessions) {
				rightLines.push(sessionLine(session, rightWidth, muted, dim));
			}
		}

		const centeredLeft = leftLines.map((line) => center(line, leftWidth));
		const lines = [borderLine("╭", `${paint("Pi")} v${VERSION}`, "╮", frameWidth, paint)];
		for (let i = 0; i < Math.max(centeredLeft.length, rightLines.length); i++) {
			lines.push(boxedLine(twoColumn(centeredLeft[i] ?? "", rightLines[i] ?? "", leftWidth, rightWidth, paint), frameWidth, paint));
		}
		lines.push(borderLine("╰", "", "╯", frameWidth, paint));
		return lines;
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
