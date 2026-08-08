import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolGlyphs } from "./icons.ts";
import { resolveToolGlyphs } from "./icons.ts";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getLanguageFromPath,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

type JsonRecord = Record<string, unknown>;

type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

type RendererState = {
	card?: OmpToolCard;
};

type RendererContext = {
	state: RendererState;
	args: unknown;
	expanded: boolean;
	isError: boolean;
};

type ToolRenderResultOptions = { expanded: boolean; isPartial: boolean };
type CardBuilder = (width: number, card: OmpToolCard, theme: Theme, glyphs: ToolGlyphs) => string[];
type CardSection = { label?: string; lines: string[] };
type ToolState = "pending" | "success" | "error";

class OmpToolCard implements Component {
	args: JsonRecord = {};
	result?: ToolResult;
	expanded = false;
	isPartial = true;
	private theme?: Theme;
	private glyphs?: ToolGlyphs;
	private readonly builder: CardBuilder;

	constructor(builder: CardBuilder) {
		this.builder = builder;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	setGlyphs(glyphs: ToolGlyphs): void {
		this.glyphs = glyphs;
	}

	render(width: number): string[] {
		return this.builder(width, this, this.theme!, this.glyphs!);
	}

	invalidate(): void {}
}

function asArgs(args: unknown): JsonRecord {
	return args && typeof args === "object" ? (args as JsonRecord) : {};
}

function stringArg(args: JsonRecord, key: string, fallback = ""): string {
	const value = args[key];
	return typeof value === "string" ? value : fallback;
}

function numberArg(args: JsonRecord, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" ? value : undefined;
}

function detailsOf(result: ToolResult | undefined): JsonRecord {
	return result?.details && typeof result.details === "object" ? (result.details as JsonRecord) : {};
}

function textResult(result: ToolResult | undefined): string {
	return (
		result?.content
			.filter((content) => content.type === "text")
			.map((content) => content.text ?? "")
			.join("\n")
			.replace(/\r/g, "") ?? ""
	);
}

function shortenPath(value: unknown): string {
	if (typeof value !== "string" || !value) return "…";
	const home = homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function stateOf(card: OmpToolCard): ToolState {
	if (card.isPartial || !card.result) return "pending";
	return card.result.isError ? "error" : "success";
}

function stateIcon(card: OmpToolCard, glyphs: ToolGlyphs, success: string): string {
	if (card.isPartial || !card.result) return glyphs.pending;
	return card.result.isError ? glyphs.error : success;
}
function stateColors(theme: Theme, state: ToolState): {
	border: (text: string) => string;
} {
	if (state === "error") return { border: (text) => theme.fg("error", text) };
	if (state === "success") return { border: (text) => theme.fg("success", text) };
	return { border: (text) => theme.fg("dim", text) };
}

function fitLine(value: string, width: number): string {
	const line = truncateToWidth(value, width, "");
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function wrapLines(lines: string[], width: number): string[] {
	return lines.flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
		return wrapped.length > 0 ? wrapped : [""];
	});
}

function frame(
	width: number,
	title: string,
	sections: CardSection[],
	theme: Theme,
	state: ToolState,
): string[] {
	const innerWidth = Math.max(1, width - 2);
	const { border } = stateColors(theme, state);
	const paint = (line: string) => fitLine(line, width);
	const rows: string[] = [];

	const topLeft = "╭───";
	const bottomLeft = "╰───";
	const titleText = title ? ` ${truncateToWidth(title, Math.max(0, width - visibleWidth(topLeft) - 1), "")} ` : "";
	rows.push(
		paint(
			`${border(topLeft)}${titleText}${border("─".repeat(Math.max(0, width - visibleWidth(topLeft) - visibleWidth(titleText) - 1)))}${border("╮")}`,
		),
	);

	for (const section of sections) {
		if (section.label) {
			const left = "├───";
			const sectionLabel = ` ${truncateToWidth(section.label, Math.max(0, width - visibleWidth(left) - 1), "")} `;
			rows.push(
				paint(
					`${border(left)}${sectionLabel}${border("─".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(sectionLabel) - 1)))}${border("┤")}`,
				),
			);
		}
		for (const line of wrapLines(section.lines, innerWidth)) {
			rows.push(paint(`${border("│")}${fitLine(line, innerWidth)}${border("│")}`));
		}
	}

	rows.push(paint(`${border(bottomLeft)}${border("─".repeat(Math.max(0, width - 5)))}${border("╯")}`));
	return rows;
}

function inlineLines(width: number, lines: string[]): string[] {
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function fileTitle(
	theme: Theme,
	card: OmpToolCard,
	glyphs: ToolGlyphs,
	icon: string,
	name: string,
	path: string,
	suffix = "",
): string {
	const color = card.result?.isError ? "error" : card.isPartial || !card.result ? "warning" : "success";
	return `${theme.fg(color, `${stateIcon(card, glyphs, icon)} ${name}`)} ${theme.fg("accent", path)}${suffix}`;
}

function previewLines(text: string, expanded: boolean, limit: number, theme: Theme): string[] {
	const lines = text.split("\n");
	const visible = expanded ? lines : lines.slice(0, limit);
	const output = visible.map((line, index) => `${theme.fg("dim", `${String(index + 1).padStart(4)} `)}${theme.fg("toolOutput", line)}`);
	if (!expanded && lines.length > limit) {
		output.push(theme.fg("muted", `… (${lines.length - limit} more lines · Ctrl+O to expand)`));
	}
	return output;
}

function diffLines(diff: string, theme: Theme): string[] {
	return diff.split("\n").map((line) => {
		if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
		if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
		return theme.fg("dim", line);
	});
}

function treeLines(text: string, limit: number, theme: Theme): string[] {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	const visible = lines.slice(0, limit);
	const output = visible.map((line, index) => {
		const branch = index === visible.length - 1 && visible.length === lines.length ? "└─" : "├─";
		return `${theme.fg("accent", branch)} ${theme.fg("toolOutput", line)}`;
	});
	if (lines.length > limit) output.push(theme.fg("muted", `└─ … ${lines.length - limit} more`));
	return output;
}

function readCard(width: number, card: OmpToolCard, theme: Theme, glyphs: ToolGlyphs): string[] {
	const path = shortenPath(card.args.file_path ?? card.args.path);
	const offset = numberArg(card.args, "offset");
	const limit = numberArg(card.args, "limit");
	const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
	const title = fileTitle(theme, card, glyphs, glyphs.read, "Read", `${path}${range}`);
	return inlineLines(width, [title]);
}

function bashCard(width: number, card: OmpToolCard, theme: Theme, glyphs: ToolGlyphs): string[] {
	const command = stringArg(card.args, "command", "…");
	const sections: CardSection[] = [{ lines: [theme.fg("toolTitle", `${glyphs.command} ${command}`)] }];
	if (card.result) {
		const output = textResult(card.result).trimEnd();
		const rawLines = output ? output.split("\n") : [];
		const shown = card.expanded ? rawLines : rawLines.slice(-5);
		const lines = shown.length > 0 ? shown.map((line) => theme.fg("toolOutput", line)) : [theme.fg("muted", "(no output)")];
		if (!card.expanded && rawLines.length > 5) lines.unshift(theme.fg("muted", "… earlier output · Ctrl+O to expand"));
		sections.push({ label: "Output", lines });
		sections.push({ lines: [theme.fg(card.result.isError ? "error" : "muted", card.result.isError ? `${glyphs.error} failed` : `${glyphs.success} done`)] });
	}
	return frame(width, "", sections, theme, stateOf(card));
}

function editCard(width: number, card: OmpToolCard, theme: Theme, glyphs: ToolGlyphs): string[] {
	const path = shortenPath(card.args.file_path ?? card.args.path);
	const details = detailsOf(card.result);
	const diff = typeof details.diff === "string" ? details.diff : "";
	const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
	const removals = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
	const stats = diff ? ` ⟦${theme.fg("success", `+${additions.length}`)}/${theme.fg("error", `-${removals.length}`)}⟧` : "";
	const title = fileTitle(theme, card, glyphs, glyphs.edit, "Edit", path, stats);
	if (!card.result || card.isPartial) return frame(width, title, [{ lines: [theme.fg("warning", "⢿ preview")] }], theme, stateOf(card));
	if (card.result.isError) return frame(width, title, [{ label: "Error", lines: [theme.fg("error", textResult(card.result) || "Edit failed")] }], theme, "error");
	if (!diff) return frame(width, title, [{ lines: [theme.fg("success", "Applied")] }], theme, "success");
	const rendered = diffLines(diff, theme);
	const lines = card.expanded ? rendered : rendered.slice(0, 12);
	if (!card.expanded && rendered.length > 12) lines.push(theme.fg("muted", "… more diff · Ctrl+O to expand"));
	return frame(width, title, [{ lines }], theme, "success");
}

function writeCard(width: number, card: OmpToolCard, theme: Theme, glyphs: ToolGlyphs): string[] {
	const path = shortenPath(card.args.file_path ?? card.args.path);
	const content = stringArg(card.args, "content");
	const title = fileTitle(theme, card, glyphs, glyphs.write, "Write", path, ` · ${content.split("\n").length} lines`);
	const language = getLanguageFromPath(stringArg(card.args, "file_path", stringArg(card.args, "path")));
	const highlighted = language ? highlightCode(content, language).join("\n") : content;
	const lines = previewLines(highlighted, card.expanded, 10, theme);
	if (card.result?.isError) lines.push(theme.fg("error", textResult(card.result) || "Write failed"));
	return frame(width, title, [{ lines }], theme, stateOf(card));
}

function searchCard(width: number, card: OmpToolCard, theme: Theme, glyphs: ToolGlyphs, kind: "grep" | "find" | "ls"): string[] {
	const path = shortenPath(card.args.path ?? ".");
	const pattern = kind === "ls" ? path : stringArg(card.args, "pattern", "…");
	const label = kind === "grep" ? `/${pattern}/ in ${path}` : kind === "find" ? `${pattern} in ${path}` : path;
	const output = textResult(card.result);
	const name = kind === "ls" ? "Ls" : kind === "grep" ? "Grep" : "Find";
	const icon = kind === "grep" ? glyphs.search : kind === "find" ? glyphs.find : glyphs.list;
	const lines = [
		`${theme.fg(card.result?.isError ? "error" : card.isPartial || !card.result ? "warning" : "accent", stateIcon(card, glyphs, icon))} ${theme.fg("toolTitle", `${name}:`)} ${theme.fg("accent", label)}`,
	];
	if (card.result && !card.result.isError && !card.isPartial) {
		const entries = output.split("\n").filter(Boolean);
		const noun = kind === "grep" ? `${entries.length} matches` : kind === "find" ? `${entries.length} files` : `${entries.length} entries`;
		lines[0] += theme.fg("muted", ` · ${noun}`);
		lines.push(...treeLines(output, card.expanded ? 30 : 8, theme));
	} else if (card.result?.isError) {
		lines.push(theme.fg("error", textResult(card.result) || `${kind} failed`));
	}
	return inlineLines(width, lines);
}


function cardRenderer(builder: CardBuilder, getGlyphs: () => ToolGlyphs) {
	return {
		renderShell: "self" as const,
		renderCall(args: unknown, theme: Theme, context: RendererContext): Component {
			const card = context.state.card ?? (context.state.card = new OmpToolCard(builder));
			card.args = asArgs(args);
			card.expanded = context.expanded;
			card.setTheme(theme);
			card.setGlyphs(getGlyphs());
			return card;
		},
		renderResult(result: ToolResult, options: ToolRenderResultOptions, theme: Theme, context: RendererContext): Component {
			const card = context.state.card ?? (context.state.card = new OmpToolCard(builder));
			card.args = asArgs(context.args);
			card.result = { ...result, isError: context.isError };
			card.expanded = options.expanded;
			card.isPartial = options.isPartial;
			card.setTheme(theme);
			card.setGlyphs(getGlyphs());
			return new Text("", 0, 0);
		},
	};
}

export function installToolRenderers(pi: ExtensionAPI, cwd: string, getGlyphs: () => ToolGlyphs = () => resolveToolGlyphs("auto")): void {
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: originalRead.name,
		label: originalRead.label,
		description: originalRead.description,
		parameters: originalRead.parameters,
		...cardRenderer(readCard, getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},
	});

	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: originalBash.name,
		label: originalBash.label,
		description: originalBash.description,
		parameters: originalBash.parameters,
		...cardRenderer(bashCard, getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},
	});

	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: originalEdit.name,
		label: originalEdit.label,
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		...cardRenderer(editCard, getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},
	});

	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: originalWrite.name,
		label: originalWrite.label,
		description: originalWrite.description,
		parameters: originalWrite.parameters,
		...cardRenderer(writeCard, getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},
	});

	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: originalGrep.name,
		label: originalGrep.label,
		description: originalGrep.description,
		parameters: originalGrep.parameters,
		...cardRenderer((width, card, theme, glyphs) => searchCard(width, card, theme, glyphs, "grep"), getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalGrep.execute(toolCallId, params, signal, onUpdate);
		},
	});

	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: originalFind.name,
		label: originalFind.label,
		description: originalFind.description,
		parameters: originalFind.parameters,
		...cardRenderer((width, card, theme, glyphs) => searchCard(width, card, theme, glyphs, "find"), getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalFind.execute(toolCallId, params, signal, onUpdate);
		},
	});

	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: originalLs.name,
		label: originalLs.label,
		description: originalLs.description,
		parameters: originalLs.parameters,
		...cardRenderer((width, card, theme, glyphs) => searchCard(width, card, theme, glyphs, "ls"), getGlyphs),
		async execute(toolCallId, params, signal, onUpdate) {
			return originalLs.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
