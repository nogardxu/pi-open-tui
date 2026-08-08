import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { unlink } from "node:fs/promises";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	fuzzyMatch,
	type Component,
	type Focusable,
	truncateToWidth,
	type AutocompleteProvider,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "./utils.ts";

const RESUME_COMMAND = "resume-popup";
const BUILTIN_RESUME_COMMAND = "resume";
const MAX_TITLE_WIDTH = 72;
const TITLE_COLUMN_RATIO = 0.7;
const MESSAGE_COUNT_COLUMN_WIDTH = 13;
const SIZE_COLUMN_WIDTH = 8;
const TIME_COLUMN_WIDTH = 5;
const COLUMN_GAP = 1;

type SessionScope = "current" | "all";
type SortMode = "threaded" | "recent" | "relevance";
type NameFilter = "all" | "named";
type SessionLoader = (onProgress?: (loaded: number, total: number) => void) => Promise<SessionInfo[]>;
type SearchToken = { kind: "fuzzy" | "phrase"; value: string };
type ParsedSearchQuery = {
	mode: "tokens" | "regex";
	tokens: SearchToken[];
	regex: RegExp | null;
	error?: string;
};

type ResumeSession = {
	session: SessionInfo;
	fileSize: number;
	messageCount: number;
	depth: number;
};
type InlineConfirmation =
	| { kind: "rename"; session: SessionInfo }
	| { kind: "delete"; session: SessionInfo };
type PopupLine = { text: string; background: "customMessageBg" | "selectedBg" };

class ResumeSessionSelector implements Component, Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly currentSessionsLoader: SessionLoader;
	private readonly allSessionsLoader: SessionLoader;
	private readonly onSelect: (sessionPath: string) => void;
	private readonly onCancel: () => void;
	private readonly onRename: (session: SessionInfo, name: string) => Promise<void>;
	private readonly onDelete: (session: SessionInfo) => Promise<void>;
	private readonly requestRender: () => void;
	private readonly searchInput = new Input();
	private readonly renameInput = new Input();
	private confirmation: InlineConfirmation | undefined;
	private currentSessions: ResumeSession[] = [];
	private allSessions: ResumeSession[] = [];
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private selectedIndex = 0;
	private loading = true;
	private progress = "Loading ...";
	private error: string | undefined;
	private loadSequence = 0;
	private _focused = false;

	constructor(
		theme: Theme,
		keybindings: KeybindingsManager,
		currentSessionsLoader: SessionLoader,
		allSessionsLoader: SessionLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onRename: (session: SessionInfo, name: string) => Promise<void>,
		onDelete: (session: SessionInfo) => Promise<void>,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.keybindings = keybindings;
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.onRename = onRename;
		this.onDelete = onDelete;
		this.requestRender = requestRender;
		this.searchInput.focused = true;
		void this.loadScope("current");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
		this.renameInput.focused = value && this.confirmation?.kind === "rename";
	}

	handleInput(data: string): void {
		if (this.confirmation) {
			this.handleConfirmationInput(data);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			void this.toggleScope();
			return;
		}
		if (this.keybindings.matches(data, "app.session.toggleSort")) {
			this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
			this.selectedIndex = 0;
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "app.session.toggleNamedFilter")) {
			this.nameFilter = this.nameFilter === "all" ? "named" : "all";
			this.selectedIndex = 0;
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "app.session.delete")) {
			const selected = this.getVisibleSessions()[this.selectedIndex];
			if (selected) this.startDeleteConfirmation(selected.session);
			return;
		}
		if (this.keybindings.matches(data, "app.session.rename")) {
			const selected = this.getVisibleSessions()[this.selectedIndex];
			if (selected) this.startRenameConfirmation(selected.session);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, this.getVisibleSessions().length - 1), this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(Math.max(0, this.getVisibleSessions().length - 1), this.selectedIndex + 10);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.getVisibleSessions()[this.selectedIndex];
			if (selected) this.onSelect(selected.session.path);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.selectedIndex = 0;
		this.requestRender();
	}
	render(width: number): string[] {
		if (width <= 4) return [truncateToWidth("─".repeat(Math.max(1, width)), width, "")];

		const frameWidth = width - 2;
		const contentWidth = Math.max(1, frameWidth - 2);
		const divider = this.theme.fg("accent", "─".repeat(contentWidth));
		const contentLines: PopupLine[] = [
			{ text: this.renderScope(contentWidth), background: "customMessageBg" },
			{ text: this.renderSearch(contentWidth), background: "customMessageBg" },
			{ text: divider, background: "customMessageBg" },
			...this.renderSessions(contentWidth),
			{ text: divider, background: "customMessageBg" },
			...this.renderHints(),
		];
		const border = (text: string) => this.theme.fg("accent", text);
		const top = `${border("╭")}${border("─".repeat(frameWidth))}${border("╮")}`;
		const body = contentLines.map((line) => {
			const content = truncateToWidth(line.text, contentWidth, "", true);
			return `${border("│")}${this.theme.bg(line.background, ` ${content} `)}${border("│")}`;
		});
		const bottom = `${border("╰")}${border("─".repeat(frameWidth))}${border("╯")}`;
		return [top, ...body, bottom];
	}

	invalidate(): void {
		this.searchInput.invalidate();
		this.renameInput.invalidate();
	}

	refresh(): void {
		void this.loadScope(this.scope);
	}
	private startRenameConfirmation(session: SessionInfo): void {
		this.confirmation = { kind: "rename", session };
		this.renameInput.setValue(session.name ?? "");
		this.searchInput.focused = false;
		this.renameInput.focused = this._focused;
		this.requestRender();
	}

	private startDeleteConfirmation(session: SessionInfo): void {
		this.confirmation = { kind: "delete", session };
		this.searchInput.focused = false;
		this.renameInput.focused = false;
		this.requestRender();
	}

	private handleConfirmationInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.clearConfirmation();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const confirmation = this.confirmation;
			if (!confirmation) return;
			this.clearConfirmation();
			if (confirmation.kind === "rename") {
				const name = this.renameInput.getValue().trim();
				if (name) void this.onRename(confirmation.session, name);
			} else {
				void this.onDelete(confirmation.session);
			}
			return;
		}
		if (this.confirmation?.kind === "rename") {
			this.renameInput.handleInput(data);
			this.requestRender();
		}
	}

	private clearConfirmation(): void {
		this.confirmation = undefined;
		this.renameInput.focused = false;
		this.searchInput.focused = this._focused;
		this.requestRender();
	}

	private renderHints(): PopupLine[] {
		if (this.confirmation?.kind === "rename") {
			return [{ text: this.theme.fg("muted", "Enter save · Esc cancel"), background: "customMessageBg" }];
		}
		if (this.confirmation?.kind === "delete") {
			return [{ text: this.theme.fg("muted", "Enter confirm · Esc cancel"), background: "customMessageBg" }];
		}
		return [
			{ text: this.theme.fg("muted", "Tab scope · Ctrl+S sort · Ctrl+N named · Ctrl+D delete · Ctrl+R rename"), background: "customMessageBg" },
			{ text: this.theme.fg("muted", "↑/↓ move · Enter resume · Esc close"), background: "customMessageBg" },
		];
	}

	private renderScope(width: number): string {
		const scope = this.scope === "current" ? "◉ Current Folder  ○ All" : "○ Current Folder  ◉ All";
		const status = `Name: ${this.nameFilter === "all" ? "All" : "Named"}  Sort: ${this.sortMode[0]!.toUpperCase()}${this.sortMode.slice(1)}`;
		return truncateToWidth(`${this.theme.fg("accent", scope)}  ${this.theme.fg("muted", status)}`, width, "", true);
	}

	private renderSearch(width: number): string {
		if (this.confirmation?.kind === "rename") {
			const label = "Rename: ";
			const inputWidth = Math.max(1, width - visibleWidth(label));
			return truncateToWidth(`${this.theme.fg("warning", label)}${this.renameInput.render(inputWidth)[0] ?? "> "}`, width, "", true);
		}
		if (this.confirmation?.kind === "delete") {
			const title = stripAnsi(this.confirmation.session.name || this.confirmation.session.firstMessage || "Untitled session").replace(/\s+/g, " ").trim();
			return truncateToWidth(this.theme.fg("warning", `Delete "${title}"? Enter confirm · Esc cancel`), width, "", true);
		}
		return truncateToWidth(this.searchInput.render(width)[0] ?? "> ", width, "", true);
	}

	private renderSessions(width: number): PopupLine[] {
		if (this.loading) return [{ text: this.theme.fg("muted", this.progress), background: "customMessageBg" }];
		if (this.error) return [{ text: this.theme.fg("error", this.error), background: "customMessageBg" }];
		const searchError = parseSearchQuery(this.searchInput.getValue()).error;
		if (searchError) return [{ text: this.theme.fg("error", searchError), background: "customMessageBg" }];
		const sessions = this.getVisibleSessions();
		if (sessions.length === 0) {
			return [{ text: this.theme.fg("muted", this.scope === "current" ? "No sessions in current folder. Press Tab to view all." : "No sessions found."), background: "customMessageBg" }];
		}
		const selectedPath = sessions[this.selectedIndex]?.session.path;
		const lines = sessions.map((session) => this.renderSession(session, width, selectedPath));
		if (this.selectedIndex >= sessions.length) this.selectedIndex = Math.max(0, sessions.length - 1);
		return lines;
	}

	private renderSession(row: ResumeSession, width: number, selectedPath: string | undefined): PopupLine {
		const title = `${"  ".repeat(row.depth)}${stripAnsi(row.session.name || row.session.firstMessage || "Untitled session").replace(/\s+/g, " ").trim()}`;
		const messageCountColumn = fitSessionColumn(`${row.messageCount} messages`, MESSAGE_COUNT_COLUMN_WIDTH);
		const sizeColumn = fitSessionColumn(formatFileSize(row.fileSize), SIZE_COLUMN_WIDTH);
		const timeColumn = fitSessionColumn(formatSessionAge(row.session.modified), TIME_COLUMN_WIDTH);
		const suffix = [messageCountColumn, sizeColumn, timeColumn].join(" ".repeat(COLUMN_GAP));
		const suffixWidth = visibleWidth(suffix);
		const availableTitleWidth = Math.max(1, width - suffixWidth - 3);
		const titleWidth = Math.min(MAX_TITLE_WIDTH, Math.floor(width * TITLE_COLUMN_RATIO), availableTitleWidth);
		const selected = selectedPath === row.session.path;
		const titleText = truncateWithoutReset(title, titleWidth, "…");
		const left = `${selected ? "› " : "  "}${titleText}`;
		const spacing = " ".repeat(Math.max(1, width - visibleWidth(left) - suffixWidth));
		const line = truncateWithoutReset(`${left}${spacing}${suffix}`, width, "", true);
		return {
			text: selected ? this.theme.bold(this.theme.fg("accent", line)) : line,
			background: selected ? "selectedBg" : "customMessageBg",
		};
	}

	private getVisibleSessions(): ResumeSession[] {
		const source = this.scope === "current" ? this.currentSessions : this.allSessions;
		const queryText = this.searchInput.getValue();
		const parsed = parseSearchQuery(queryText);
		const named = this.nameFilter === "named" ? source.filter((row) => Boolean(row.session.name?.trim())) : source;
		const matched = named.flatMap((row) => {
			const result = matchResumeSession(row.session, parsed);
			return result.matches ? [{ row, score: result.score }] : [];
		});
		if (!queryText.trim()) return this.sortMode === "threaded" ? flattenThreadedSessions(named) : named;
		if (this.sortMode === "recent") return matched.map(({ row }) => row);
		return matched.sort((a, b) => a.score - b.score || b.row.session.modified.getTime() - a.row.session.modified.getTime()).map(({ row }) => row);
	}

	private async toggleScope(): Promise<void> {
		this.scope = this.scope === "current" ? "all" : "current";
		this.selectedIndex = 0;
		if (this.scope === "all" && this.allSessions.length === 0) {
			await this.loadScope("all");
		} else {
			this.requestRender();
		}
	}


	private async loadScope(scope: SessionScope): Promise<void> {
		const sequence = ++this.loadSequence;
		this.loading = true;
		this.error = undefined;
		this.progress = "Loading ...";
		this.requestRender();
		try {
			const loader = scope === "current" ? this.currentSessionsLoader : this.allSessionsLoader;
			const sessions = await loader((loaded, total) => {
				if (sequence !== this.loadSequence) return;
				this.progress = `Loading ${loaded}/${total}`;
				this.requestRender();
			});
			const enriched = sessions.map(createSessionRow);
			if (sequence !== this.loadSequence) return;
			if (scope === "current") this.currentSessions = enriched;
			else this.allSessions = enriched;
			this.loading = false;
			this.selectedIndex = 0;
			this.requestRender();
		} catch (error: unknown) {
			if (sequence !== this.loadSequence) return;
			this.loading = false;
			this.error = error instanceof Error ? error.message : String(error);
			this.requestRender();
		}
	}
}

function createSessionRow(session: SessionInfo): ResumeSession {
	let fileSize = 0;
	try {
		fileSize = statSync(session.path).size;
	} catch {
		// The session may disappear while the list is being rendered.
	}
	return { session, fileSize, messageCount: session.messageCount, depth: 0 };
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes;
	let unit = "B";
	for (const nextUnit of units) {
		value /= 1024;
		unit = nextUnit;
		if (value < 1024 || nextUnit === units.at(-1)) break;
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
function truncateWithoutReset(value: string, width: number, ellipsis: string, pad = false): string {
	return truncateToWidth(value, width, ellipsis, pad).replace(/\x1b\[0m/g, "");
}

function fitSessionColumn(value: string, width: number): string {
	const text = truncateWithoutReset(value, width, "…");
	return `${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}

function formatSessionAge(date: Date): string {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 365) return `${days}d`;
	return `${Math.floor(days / 365)}y`;
}

function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [], regex: null };
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (error: unknown) {
			return { mode: "regex", tokens: [], regex: null, error: error instanceof Error ? error.message : String(error) };
		}
	}
	const tokens: SearchToken[] = [];
	let value = "";
	let inQuote = false;
	let unclosedQuote = false;
	const flush = (kind: SearchToken["kind"]) => {
		const token = value.trim();
		value = "";
		if (token) tokens.push({ kind, value: token });
	};
	for (const char of trimmed) {
		if (char === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
		} else if (!inQuote && /\s/.test(char)) {
			flush("fuzzy");
		} else {
			value += char;
		}
	}
	if (inQuote) unclosedQuote = true;
	if (unclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed.split(/\s+/).filter(Boolean).map((token) => ({ kind: "fuzzy", value: token })),
			regex: null,
		};
	}
	flush(inQuote ? "phrase" : "fuzzy");
	return { mode: "tokens", tokens, regex: null };
}

function matchResumeSession(session: SessionInfo, parsed: ParsedSearchQuery): { matches: boolean; score: number } {
	const text = `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const index = text.search(parsed.regex);
		return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
	}
	let totalScore = 0;
	let normalizedText: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			normalizedText ??= normalizeSearchText(text);
			const index = normalizedText.indexOf(normalizeSearchText(token.value));
			if (index < 0) return { matches: false, score: 0 };
			totalScore += index * 0.1;
		} else {
			const result = fuzzyMatch(token.value, text);
			if (!result.matches) return { matches: false, score: 0 };
			totalScore += result.score;
		}
	}
	return { matches: true, score: totalScore };
}

function normalizeSearchText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function flattenThreadedSessions(sessions: ResumeSession[]): ResumeSession[] {
	const byPath = new Map(sessions.map((row) => [row.session.path, row]));
	const children = new Map<string, ResumeSession[]>();
	const roots: ResumeSession[] = [];
	for (const row of sessions) {
		const parent = row.session.parentSessionPath;
		if (parent && byPath.has(parent)) {
			const siblings = children.get(parent) ?? [];
			siblings.push(row);
			children.set(parent, siblings);
		} else {
			roots.push(row);
		}
	}
	const newestFirst = (a: ResumeSession, b: ResumeSession) => b.session.modified.getTime() - a.session.modified.getTime();
	const flattened: ResumeSession[] = [];
	const visited = new Set<string>();
	const visit = (row: ResumeSession, depth: number) => {
		if (visited.has(row.session.path)) return;
		visited.add(row.session.path);
		flattened.push({ ...row, depth });
		for (const child of (children.get(row.session.path) ?? []).sort(newestFirst)) visit(child, depth + 1);
	};
	for (const root of roots.sort(newestFirst)) visit(root, 0);
	for (const row of [...sessions].sort(newestFirst)) visit(row, 0);
	return flattened;
}

function createSessionSelector(
	ctx: ExtensionCommandContext,
	requestRender: () => void,
	done: () => void,
	keybindings: KeybindingsManager,
	theme: Theme,
): ResumeSessionSelector {
	const sessionManager = ctx.sessionManager as ExtensionCommandContext["sessionManager"] & {
		usesDefaultSessionDir?: () => boolean;
	};
	const currentSessions = (onProgress?: (loaded: number, total: number) => void) =>
		SessionManager.list(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionDir(), onProgress);
	const allSessions = (onProgress?: (loaded: number, total: number) => void) =>
		sessionManager.usesDefaultSessionDir?.()
			? SessionManager.listAll(onProgress)
			: SessionManager.listAll(sessionManager.getSessionDir(), onProgress);

	let selector: ResumeSessionSelector;
	selector = new ResumeSessionSelector(
		theme,
		keybindings,
		currentSessions,
		allSessions,
		(sessionPath) => {
			done();
			void ctx.switchSession(sessionPath).catch((error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			});
		},
		done,
		async (session, name) => {
			try {
				SessionManager.open(session.path).appendSessionInfo(name);
				selector.refresh();
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
		async (session) => {
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			if (currentSessionFile && resolve(session.path) === resolve(currentSessionFile)) {
				ctx.ui.notify("Cannot delete the currently active session", "error");
				return;
			}
			const trashArgs = session.path.startsWith("-") ? ["--", session.path] : [session.path];
			const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
			try {
				if (trashResult.status !== 0 && existsSync(session.path)) await unlink(session.path);
				selector.refresh();
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
		requestRender,
	);
	return selector;
}

export function registerResumeCommand(pi: ExtensionAPI): void {
	pi.registerCommand(RESUME_COMMAND, {
		description: "Resume a session in a popup",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => createSessionSelector(ctx, () => tui.requestRender(), done, keybindings, theme),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "80%",
						minWidth: 48,
						maxHeight: "80%",
						margin: 1,
					},
				},
			);
		},
	});
}

export function installResumeAutocompleteFilter(ctx: ExtensionContext): void {
	ctx.ui.addAutocompleteProvider((current: AutocompleteProvider): AutocompleteProvider => {
		const wrapped: AutocompleteProvider = {
			triggerCharacters: current.triggerCharacters,
			applyCompletion: current.applyCompletion.bind(current),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions || !suggestions.prefix.startsWith("/")) return suggestions;
				const items = suggestions.items.filter((item) => item.value !== BUILTIN_RESUME_COMMAND);
				return items.length > 0 ? { ...suggestions, items } : null;
			},
		};
		if (current.shouldTriggerFileCompletion) {
			wrapped.shouldTriggerFileCompletion = current.shouldTriggerFileCompletion.bind(current);
		}
		return wrapped;
	});
}
