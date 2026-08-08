import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { installToolRenderers } from "../extensions/open-tui/tool-renderers.ts";
import { resolveToolGlyphs } from "../extensions/open-tui/icons.ts";

type Rendered = { render(width: number): string[] };
type RenderContext = {
	args: unknown;
	state: Record<string, unknown>;
	expanded: boolean;
	isError: boolean;
};
type RegisteredTool = {
	name: string;
	renderCall(args: unknown, theme: Theme, context: RenderContext): Rendered;
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: RenderContext,
	): Rendered;
};

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("colors edit diff statistics without a card background", () => {
	const calls: Array<{ color: string; text: string }> = [];
	let backgroundCalls = 0;
	const colorTheme = {
		fg(color: string, text: string) {
			calls.push({ color, text });
			return text;
		},
		bg: (_color: string, text: string) => {
			backgroundCalls++;
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	const edit = register("nerd").find((tool) => tool.name === "edit")!;
	const args = { path: "file.txt", edits: [] };
	const context: RenderContext = { args, state: {}, expanded: false, isError: false };
	const component = edit.renderCall(args, colorTheme, context);
	edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff: "@@\n-old\n+new\n+again" } },
		{ expanded: false, isPartial: false },
		colorTheme,
		context,
	);
	component.render(80);
	assert.ok(calls.some((call) => call.color === "success" && call.text === "+2"));
	assert.ok(calls.some((call) => call.color === "error" && call.text === "-1"));
	assert.equal(backgroundCalls, 0);
});

test("uses muted state colors for card borders", () => {
	const colors: string[] = [];
	const stateTheme = {
		fg(color: string, text: string) {
			colors.push(color);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const edit = register("nerd").find((tool) => tool.name === "edit")!;
	const args = { path: "file.txt", edits: [] };
	const pendingContext: RenderContext = { args, state: {}, expanded: false, isError: false };
	edit.renderCall(args, stateTheme, pendingContext).render(80);
	assert.ok(colors.includes("dim"));

	colors.length = 0;
	const successContext: RenderContext = { args, state: {}, expanded: false, isError: false };
	const success = edit.renderCall(args, stateTheme, successContext);
	edit.renderResult({ content: [{ type: "text", text: "ok" }], details: {} }, { expanded: false, isPartial: false }, stateTheme, successContext);
	success.render(80);
	assert.ok(colors.includes("success"));

	colors.length = 0;
	const errorContext: RenderContext = { args, state: {}, expanded: false, isError: true };
	const error = edit.renderCall(args, stateTheme, errorContext);
	edit.renderResult({ content: [{ type: "text", text: "failed" }], details: {} }, { expanded: false, isPartial: false }, stateTheme, errorContext);
	error.render(80);
	assert.ok(colors.includes("error"));
});

function register(mode: "nerd" | "ascii"): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	// Test-only structural adapter: capture registered definitions without constructing ExtensionAPI.
	const api = {
		registerTool(definition: unknown) {
			tools.push(definition as unknown as RegisteredTool);
		},
	} as unknown as ExtensionAPI;
	installToolRenderers(api, process.cwd(), () => resolveToolGlyphs(mode));
	return tools;
}

function render(
	tool: RegisteredTool,
	args: Record<string, unknown>,
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	isError = false,
): string {
	const context: RenderContext = { args, state: {}, expanded: false, isError };
	const component = tool.renderCall(args, theme, context);
	tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
	return component.render(80).join("\n");
}


test("renders read as a single summary line", () => {
	const read = register("ascii").find((tool) => tool.name === "read")!;
	const output = render(read, { path: "file.txt", offset: 1, limit: 2 }, { content: [{ type: "text", text: "one\ntwo" }] });
	assert.equal(output.split("\n").length, 1);
	assert.match(output, /\+ Read file\.txt:1-2/);
});
test("maps tool glyphs for Nerd Font and ASCII modes", () => {
	assert.equal(resolveToolGlyphs("nerd").write, "✎");
	assert.equal(resolveToolGlyphs("nerd").error, "✘");
	assert.equal(resolveToolGlyphs("ascii").command, "$");
	assert.equal(resolveToolGlyphs("ascii").success, "+");
	assert.equal(resolveToolGlyphs("ascii").error, "x");
});

test("renders universal ASCII success and failure markers", () => {
	const tools = register("ascii");
	const read = tools.find((tool) => tool.name === "read")!;
	const bash = tools.find((tool) => tool.name === "bash")!;
	assert.match(render(read, { path: "file.txt" }, { content: [{ type: "text", text: "ok" }] }), /\+ Read/);
	assert.match(render(read, { path: "file.txt" }, { content: [{ type: "text", text: "failed" }] }, true), /x Read/);
	assert.match(render(bash, { command: "printf ok" }, { content: [{ type: "text", text: "ok" }] }), /\$ printf ok/);
	assert.match(render(bash, { command: "false" }, { content: [{ type: "text", text: "failed" }] }, true), /x failed/);
});

test("renders Nerd Font write and failure markers", () => {
	const tools = register("nerd");
	const write = tools.find((tool) => tool.name === "write")!;
	const edit = tools.find((tool) => tool.name === "edit")!;
	assert.match(render(write, { path: "file.txt", content: "ok" }, { content: [{ type: "text", text: "ok" }] }), /✎ Write/);
	assert.match(render(edit, { path: "file.txt", edits: [] }, { content: [{ type: "text", text: "failed" }] }, true), /✘ Edit/);
});
