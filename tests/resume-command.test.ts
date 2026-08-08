import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { installResumeAutocompleteFilter, registerResumeCommand } from "../extensions/open-tui/resume-command.ts";

test("hides the built-in resume candidate without breaking autocomplete", async () => {
	let wrapped: AutocompleteProvider | undefined;
	const base: AutocompleteProvider = {
		triggerCharacters: [],
		async getSuggestions() {
			return {
				prefix: "/r",
				items: [
					{ value: "resume", label: "resume" },
					{ value: "resume-popup", label: "resume-popup" },
				],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	};
	const ctx = {
		ui: {
			addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
				wrapped = factory(base);
			},
		},
	} as unknown as ExtensionContext;

	installResumeAutocompleteFilter(ctx);
	assert.ok(wrapped);
	const result = await wrapped.getSuggestions([], 0, 0, { signal: new AbortController().signal });
	assert.deepEqual(result?.items.map((item) => item.value), ["resume-popup"]);
	assert.deepEqual(wrapped.applyCompletion([], 0, 0, { value: "resume-popup", label: "resume-popup" }, "/r"), {
		lines: [],
		cursorLine: 0,
		cursorCol: 0,
	});
});

test("registers the popup resume command", () => {
	let registeredName: string | undefined;
	const pi = {
		registerCommand(name: string) {
			registeredName = name;
		},
	} as unknown as ExtensionAPI;

	registerResumeCommand(pi);
	assert.equal(registeredName, "resume-popup");
});
