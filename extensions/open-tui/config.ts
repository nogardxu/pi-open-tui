import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { IconMode } from "./icons.ts";

export type FooterSeparator = "dot" | "pipe" | "slash" | "arrow";

export const GIT_STATUS_REFRESH_INTERVALS_MS = [1_000, 10_000, 30_000, 60_000, 120_000, 600_000] as const;
export const DEFAULT_GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;

export type { IconMode } from "./icons.ts";

export interface FooterSegments {
	cwd: boolean;
	model: boolean;
	thinking: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
	clock: boolean;
}

export interface GitConfig {
	statusRefreshIntervalMs: number;
}

export interface TelemetryConfig {
	enabled: boolean;
	timestamp: boolean;
	inputTokens: boolean;
	outputTokens: boolean;
	cacheRate: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	cost: boolean;
}

export interface OpenTuiConfig {
	enabled: boolean;
	icons: {
		mode: IconMode;
	};
	footer: {
		separator: FooterSeparator;
	};
	git: GitConfig;
	footerSegments: FooterSegments;
	telemetry: TelemetryConfig;
}

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	icons: {
		mode: "auto",
	},
	footer: {
		separator: "dot",
	},
	git: {
		statusRefreshIntervalMs: DEFAULT_GIT_STATUS_REFRESH_INTERVAL_MS,
	},
	footerSegments: {
		cwd: true,
		model: true,
		thinking: true,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,
		runtime: true,
		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
		clock: true,
	},
	telemetry: {
		enabled: true,
		timestamp: true,
		inputTokens: true,
		outputTokens: true,
		cacheRate: true,
		tps: true,
		ttft: true,
		duration: true,
		cost: true,
	},
};

export function getConfigPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "open-tui.json");
}

function deepMerge<T>(base: T, override: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (override as T) ?? base;
	}
	if (typeof override !== "object" || override === null || Array.isArray(override)) {
		return base;
	}
	const result = { ...(base as Record<string, unknown>) };
	const overrideRec = override as Record<string, unknown>;
	for (const key of Object.keys(overrideRec)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = overrideRec[key];
		if (typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)
			&& typeof overVal === "object" && overVal !== null && !Array.isArray(overVal)) {
			result[key] = deepMerge(baseVal, overVal);
		} else if (overVal !== undefined) {
			result[key] = overVal;
		}
	}
	return result as T;
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config creation is best-effort
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}

	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const config = deepMerge(DEFAULT_CONFIG, parsed);
		// Drop removed settings and split the legacy telemetry token switch.
		const rawTelemetry = (parsed as { telemetry?: unknown }).telemetry;
		if (typeof rawTelemetry === "object" && rawTelemetry !== null && !Array.isArray(rawTelemetry)) {
			const legacyTelemetry = rawTelemetry as Record<string, unknown>;
			if (typeof legacyTelemetry.tokens === "boolean") {
				for (const key of ["inputTokens", "outputTokens", "cacheRate"] as const) {
					if (legacyTelemetry[key] === undefined) config.telemetry[key] = legacyTelemetry.tokens;
				}
			}
		}
		delete (config as OpenTuiConfig & { settingsLanguage?: unknown }).settingsLanguage;
		delete (config.telemetry as TelemetryConfig & { tokens?: unknown }).tokens;
		if (!["dot", "pipe", "slash", "arrow"].includes(config.footer.separator)) {
			config.footer.separator = DEFAULT_CONFIG.footer.separator;
		}
		if (!Number.isFinite(config.git.statusRefreshIntervalMs) || config.git.statusRefreshIntervalMs < 1_000) {
			config.git.statusRefreshIntervalMs = DEFAULT_GIT_STATUS_REFRESH_INTERVAL_MS;
		}
		return config;
	} catch (err) {
		notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config save is best-effort
	}
}
