import { InvalidArgumentError, type Command } from "commander";
import { parseDuration } from "../browserMode.js";
import path from "node:path";
import fg from "fast-glob";
import type { ModelName, PreviewMode } from "../oracle.js";
import {
  CURRENT_GPT_INSTANT_MODEL,
  CURRENT_GPT_MODEL,
  CURRENT_GPT_PRO_MODEL,
  CURRENT_GPT_THINKING_MODEL,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
} from "../oracle.js";

export function collectPaths(
  value: string | string[] | undefined,
  previous: string[] = [],
): string[] {
  if (!value) {
    return previous;
  }
  const nextValues = Array.isArray(value) ? value : [value];
  return previous.concat(
    nextValues
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Merge all path-like CLI inputs (file/include aliases) into a single list, preserving order.
 */
export function mergePathLikeOptions(
  file?: string[],
  include?: string[],
  filesAlias?: string[],
  pathAlias?: string[],
  pathsAlias?: string[],
): string[] {
  const withFile = collectPaths(file, []);
  const withInclude = collectPaths(include, withFile);
  const withFilesAlias = collectPaths(filesAlias, withInclude);
  const withPathAlias = collectPaths(pathAlias, withFilesAlias);
  return collectPaths(pathsAlias, withPathAlias);
}

export function dedupePathInputs(
  inputs: string[],
  { cwd = process.cwd() }: { cwd?: string } = {},
): { deduped: string[]; duplicates: string[] } {
  const deduped: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const entry of inputs ?? []) {
    const raw = entry?.trim();
    if (!raw) continue;

    let key = raw;
    if (!raw.startsWith("!") && !fg.isDynamicPattern(raw)) {
      const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      key = `path:${path.normalize(absolute)}`;
    } else {
      key = `pattern:${raw}`;
    }

    if (seen.has(key)) {
      duplicates.push(raw);
      continue;
    }
    seen.add(key);
    deduped.push(raw);
  }

  return { deduped, duplicates };
}

export function collectModelList(value: string, previous: string[] = []): string[] {
  if (!value) {
    return previous;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return previous.concat(entries);
}

export function parseFloatOption(value: string): number {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError("Value must be a number.");
  }
  return parsed;
}

export function parseIntOption(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError("Value must be an integer.");
  }
  return parsed;
}

export function parseHeartbeatOption(value: string | number | undefined): number {
  if (value == null) {
    return 30;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value) || value < 0) {
      throw new InvalidArgumentError("Heartbeat interval must be zero or a positive number.");
    }
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return 30;
  }
  if (normalized === "false" || normalized === "off") {
    return 0;
  }
  const parsed = Number.parseFloat(normalized);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Heartbeat interval must be zero or a positive number.");
  }
  return parsed;
}

export function usesDefaultStatusFilters(cmd: Command): boolean {
  const hoursSource = cmd.getOptionValueSource?.("hours") ?? "default";
  const limitSource = cmd.getOptionValueSource?.("limit") ?? "default";
  const allSource = cmd.getOptionValueSource?.("all") ?? "default";
  return hoursSource === "default" && limitSource === "default" && allSource === "default";
}

export function resolvePreviewMode(value: boolean | string | undefined): PreviewMode | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value as PreviewMode;
  }
  if (value === true) {
    return "summary";
  }
  return undefined;
}

export function parseSearchOption(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "no"].includes(normalized)) {
    return false;
  }
  throw new InvalidArgumentError('Search mode must be "on" or "off".');
}

export function normalizeModelOption(value: string | undefined): string {
  return (value ?? "").trim();
}

export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

export function parseTimeoutOption(value: string | undefined): number | "auto" | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  const parsed = Number.parseFloat(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Timeout must be a positive number of seconds or "auto".');
  }
  return parsed;
}

export function parseDurationOption(value: string | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidArgumentError(`${label} must be a duration like 30m, 10s, 500ms, or 2h.`);
  }
  const parsed = parseDuration(trimmed, Number.NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(
      `${label} must be a positive duration like 30m, 10s, 500ms, or 2h.`,
    );
  }
  return parsed;
}

function isGeminiDeepThinkAlias(normalized: string): boolean {
  return (
    (normalized.includes("gemini") && normalized.includes("deep")) ||
    normalized.includes("deep-think") ||
    normalized.includes("deep_think") ||
    normalized.includes("deepthink")
  );
}

function resolveGeminiAlias(normalized: string): ModelName {
  if (normalized.includes("flash") && normalized.includes("lite")) {
    return "gemini-3.1-flash-lite";
  }
  if (normalized.includes("flash") || normalized.includes("fast")) {
    return "gemini-3-flash";
  }
  return "gemini-3.1-pro";
}

function resolveGrokAlias(normalized: string): ModelName {
  if (
    normalized.includes("4.20") ||
    normalized.includes("4-20") ||
    normalized.includes("multi") ||
    normalized.includes("heavy") ||
    normalized.includes("team")
  ) {
    return "grok-4.20-multi-agent";
  }
  if (normalized.includes("4.1") || normalized.includes("4-1") || normalized.includes("fast")) {
    return "grok-4-1-fast";
  }
  return "grok-4.3";
}

export function resolveApiModel(modelValue: string): ModelName {
  const normalized = normalizeModelOption(modelValue).toLowerCase();
  if (normalized.includes("/")) {
    return normalized as ModelName;
  }
  if (normalized.includes("grok")) {
    return resolveGrokAlias(normalized);
  }
  if (normalized.includes("claude") && normalized.includes("sonnet")) {
    return "claude-4.5-sonnet";
  }
  if (normalized.includes("claude") && normalized.includes("opus")) {
    return "claude-4.1-opus";
  }
  if (normalized === "sonnet") {
    return "claude-4.5-sonnet";
  }
  if (normalized === "opus") {
    return "claude-4.1-opus";
  }
  if (normalized === "claude") {
    return "claude-4.5-sonnet";
  }
  if ((normalized.includes("5.5") || normalized.includes("5.4")) && normalized.includes("pro")) {
    return CURRENT_GPT_PRO_MODEL;
  }
  if (normalized.includes("codex")) {
    if (normalized.includes("max")) {
      throw new InvalidArgumentError(
        "gpt-5.1-codex-max is not available yet. OpenAI has not released the API.",
      );
    }
    return "gpt-5.1-codex";
  }
  if (isGeminiDeepThinkAlias(normalized)) {
    throw new InvalidArgumentError(
      "Gemini Deep Think is browser-only today. Use --engine browser --model gemini-3-deep-think.",
    );
  }
  if (normalized.includes("gemini")) {
    return resolveGeminiAlias(normalized);
  }
  if (normalized in MODEL_CONFIGS) {
    if (
      normalized === "gpt-5.1-pro" ||
      normalized === "gpt-5-pro" ||
      normalized === "gpt-5.2-pro" ||
      normalized === "gpt-5.4-pro"
    ) {
      return CURRENT_GPT_PRO_MODEL;
    }
    if (normalized === "gpt-5.1" || normalized === "gpt-5.2" || normalized === "gpt-5.4") {
      return CURRENT_GPT_MODEL;
    }
    if (normalized === "gpt-5.2-thinking" || normalized === "gpt-5.4-thinking") {
      return CURRENT_GPT_THINKING_MODEL;
    }
    if (normalized === "gpt-5.2-instant") {
      return CURRENT_GPT_INSTANT_MODEL;
    }
    return normalized as ModelName;
  }
  if (
    normalized.includes("5.5") ||
    normalized.includes("5.4") ||
    normalized.includes("5.2") ||
    normalized.includes("5.1") ||
    normalized.includes("5.0") ||
    normalized === "gpt-5-pro" ||
    normalized === "gpt-5"
  ) {
    if (normalized.includes("thinking")) {
      return CURRENT_GPT_THINKING_MODEL;
    }
    if (normalized.includes("instant") || normalized.includes("fast")) {
      return CURRENT_GPT_INSTANT_MODEL;
    }
    if (normalized.includes("pro") || normalized === "gpt-5") {
      return CURRENT_GPT_PRO_MODEL;
    }
    return CURRENT_GPT_MODEL;
  }
  if (normalized.includes("pro")) {
    return CURRENT_GPT_PRO_MODEL;
  }
  // Passthrough for custom/OpenRouter model IDs.
  return normalized as ModelName;
}

export function inferModelFromLabel(modelValue: string): ModelName {
  const normalized = normalizeModelOption(modelValue).toLowerCase();
  if (!normalized) {
    return DEFAULT_MODEL;
  }
  if (normalized.includes("grok")) {
    return resolveGrokAlias(normalized);
  }
  if (normalized.includes("claude") && normalized.includes("sonnet")) {
    return "claude-4.5-sonnet";
  }
  if (normalized.includes("claude") && normalized.includes("opus")) {
    return "claude-4.1-opus";
  }
  if (isGeminiDeepThinkAlias(normalized)) {
    return "gemini-3-pro-deep-think";
  }
  if (normalized.includes("gemini")) {
    return resolveGeminiAlias(normalized);
  }
  if (normalized.includes("codex")) {
    return "gpt-5.1-codex";
  }
  if (normalized in MODEL_CONFIGS) {
    if (
      normalized === "gpt-5.1-pro" ||
      normalized === "gpt-5-pro" ||
      normalized === "gpt-5.2-pro" ||
      normalized === "gpt-5.4-pro"
    ) {
      return CURRENT_GPT_PRO_MODEL;
    }
    if (normalized === "gpt-5.2-thinking" || normalized === "gpt-5.4-thinking") {
      return CURRENT_GPT_THINKING_MODEL;
    }
    if (normalized === "gpt-5.2-instant") {
      return CURRENT_GPT_INSTANT_MODEL;
    }
    if (normalized === "gpt-5.1" || normalized === "gpt-5.2" || normalized === "gpt-5.4") {
      return CURRENT_GPT_MODEL;
    }
    return normalized as ModelName;
  }
  const references55 = normalized.includes("5.5") || normalized.includes("5_5");
  const references54 = normalized.includes("5.4") || normalized.includes("5_4");
  const references53 = normalized.includes("5.3") || normalized.includes("5_3");
  const references52 = normalized.includes("5.2") || normalized.includes("5_2");
  const references51 = normalized.includes("5.1") || normalized.includes("5_1");
  const references50 = normalized.includes("5.0") || normalized.includes("5_0");

  if (normalized.includes("classic")) {
    return CURRENT_GPT_PRO_MODEL;
  }
  if (
    references55 ||
    references54 ||
    references53 ||
    references52 ||
    references51 ||
    references50 ||
    normalized.includes("gpt-5")
  ) {
    if (normalized.includes("pro")) {
      return CURRENT_GPT_PRO_MODEL;
    }
    if (references52 && (normalized.includes("instant") || normalized.includes("fast"))) {
      return CURRENT_GPT_INSTANT_MODEL;
    }
    if (
      (references55 || references54) &&
      (normalized.includes("instant") || normalized.includes("fast"))
    ) {
      return CURRENT_GPT_INSTANT_MODEL;
    }
    if (references53 && (normalized.includes("instant") || normalized.includes("fast"))) {
      return CURRENT_GPT_INSTANT_MODEL;
    }
    if (references52 && normalized.includes("thinking")) {
      return CURRENT_GPT_THINKING_MODEL;
    }
    if ((references55 || references54) && normalized.includes("thinking")) {
      return CURRENT_GPT_THINKING_MODEL;
    }
    if (references51 || references50 || references54 || references55) {
      return CURRENT_GPT_MODEL;
    }
  }
  if (normalized.includes("thinking")) {
    return CURRENT_GPT_THINKING_MODEL;
  }
  if (normalized.includes("instant") || normalized.includes("fast")) {
    return CURRENT_GPT_INSTANT_MODEL;
  }
  if (normalized.includes("pro")) {
    return CURRENT_GPT_PRO_MODEL;
  }
  return CURRENT_GPT_MODEL;
}
