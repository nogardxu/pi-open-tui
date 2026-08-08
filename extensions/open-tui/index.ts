import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { readGitStatus } from "./git.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import { installResumeAutocompleteFilter, registerResumeCommand } from "./resume-command.ts";
import { formatTurnTelemetry, type TurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import { formatDuration } from "./utils.ts";
import {
	createInitialState,
	getModelMeta,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";
import { installToolRenderers } from "./tool-renderers.ts";
import { resolveToolGlyphs } from "./icons.ts";

function isInteractiveLaunch(): boolean {
	if (!process.stdout.isTTY) return false;
	const args = process.argv.slice(2);
	const nonInteractiveFlags = ["-p", "--print", "--help", "-h", "--version", "-v", "--list-models", "--export"];
	for (const arg of args) {
		if (nonInteractiveFlags.includes(arg)) return false;
		if (arg.startsWith("--mode")) return false;
	}
	return true;
}

function clearVisibleScreen(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	if (typeof pi.registerTool === "function") {
		installToolRenderers(pi, process.cwd(), () => resolveToolGlyphs(config.icons.mode));
	}
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let active = false;
	let resumeAutocompleteInstalled = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let gitRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let gitRefreshInFlight = false;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupEditor: (() => void) | undefined;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	const stopWorkingDisplay = (ctx?: ExtensionContext) => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
		if (ctx && isTuiContext(ctx) && typeof ctx.ui.setWorkingMessage === "function") {
			ctx.ui.setWorkingMessage();
		}
	};

	const startWorkingDisplay = (ctx: ExtensionContext) => {
		stopWorkingDisplay(ctx);
		if (!isTuiContext(ctx)) return;
		const startedAt = Date.now();
		if (typeof ctx.ui.setWorkingMessage !== "function") return;
		const update = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			ctx.ui.setWorkingMessage(`Working... ${formatDuration(Date.now() - startedAt)}`);
		};
		update();
		workingTimer = setInterval(update, 1000);
		workingTimer.unref?.();
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx);
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			cleanupEditor = installEditor(pi, ctx);
			active = true;
		}
		startGitRefreshTimer(ctx);
	};

	const refreshHeader = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx) || !active || !config.enabled) return;
		cleanupHeader?.();
		cleanupHeader = installHeader(pi, ctx);
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		stopGitRefreshTimer();
		if (!isTuiContext(ctx)) return;
		stopWorkingDisplay(ctx);
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			cleanupEditor?.();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			cleanupEditor = undefined;
			requestFooterRender = undefined;
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent() || gitRefreshInFlight) return;
		gitRefreshInFlight = true;
		try {
			const generation = sessionLifecycle.currentGeneration();
			const cwd = ctx.cwd;
			const git = await readGitStatus(cwd, {
				readCommit: true,
				readTag: config.footerSegments.gitCommit,
			});
			if (!sessionLifecycle.isCurrent(generation)) return;
			state.git = git;
			requestFooterRender?.();
		} finally {
			gitRefreshInFlight = false;
		}
	};

	const stopGitRefreshTimer = () => {
		if (gitRefreshTimer) {
			clearInterval(gitRefreshTimer);
			gitRefreshTimer = undefined;
		}
	};

	const startGitRefreshTimer = (ctx: ExtensionContext) => {
		stopGitRefreshTimer();
		if (!isTuiContext(ctx) || !config.enabled || !active) return;
		gitRefreshTimer = setInterval(() => {
			if (!sessionLifecycle.isCurrent() || !active || !config.enabled) return;
			void scheduleGitRefresh(ctx);
		}, config.git.statusRefreshIntervalMs);
		gitRefreshTimer.unref?.();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			void scheduleGitRefresh(ctx);
			void refreshRuntime(ctx);
		}
		requestFooterRender?.();
	};

	const notifyTelemetry = (telemetry: TurnTelemetry | undefined, ctx: ExtensionContext, tone: "dim" | "muted") => {
		if (!telemetry || !config.enabled || !config.telemetry.enabled || !isTuiContext(ctx)) return;
		const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry, config.icons.mode, undefined, tone);
		if (message) ctx.ui.notify(message, "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		lastCtx = ctx;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));
		if (isTuiContext(ctx) && !resumeAutocompleteInstalled) {
			installResumeAutocompleteFilter(ctx);
			resumeAutocompleteInstalled = true;
		}

		if (isInteractiveLaunch() && config.enabled) {
			clearVisibleScreen();
		}

		const wasActive = active;
		applyUi(ctx);
		if (wasActive) refreshHeader(ctx);

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		stopWorkingDisplay(ctx);
		stopGitRefreshTimer();
		resumeAutocompleteInstalled = false;
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		startWorkingDisplay(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingDisplay(ctx);
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_update", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (config.telemetry.perTurn) notifyTelemetry(telemetry, ctx, "dim");
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		notifyTelemetry(telemetry, ctx, "muted");
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerResumeCommand(pi);
	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const wasEnabled = config.enabled;
			saveConfig(newConfig);
			config = newConfig;
			if (lastCtx && wasEnabled !== newConfig.enabled) {
				if (newConfig.enabled) {
					applyUi(lastCtx);
				} else {
					uninstallUi(lastCtx);
				}
			}
			if (lastCtx && active) startGitRefreshTimer(lastCtx);
			requestFooterRender?.();
		},
	});
}
