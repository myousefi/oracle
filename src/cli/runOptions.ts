import type { RunOracleOptions, ModelName } from '../oracle.js';
import { DEFAULT_MODEL, MODEL_CONFIGS } from '../oracle.js';
import type { UserConfig } from '../config.js';
import type { EngineMode } from './engine.js';
import { resolveEngine } from './engine.js';
import { normalizeModelOption, inferModelFromLabel, normalizeBaseUrl } from './options.js';
import { resolveGeminiModelId } from '../oracle/gemini.js';
import { PromptValidationError } from '../oracle/errors.js';
import { normalizeChatGptModelForBrowser } from './browserConfig.js';

export interface ResolveRunOptionsInput {
  prompt: string;
  files?: string[];
  model?: string;
  models?: string[];
  engine?: EngineMode;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedRunOptions {
  runOptions: RunOracleOptions;
  resolvedEngine: EngineMode;
}

export function resolveRunOptionsFromConfig({
  prompt,
  files = [],
  model,
  models,
  engine,
  userConfig,
  env = process.env,
}: ResolveRunOptionsInput): ResolvedRunOptions {
  if (
    engine === 'api' ||
    userConfig?.engine === 'api' ||
    (env.ORACLE_ENGINE ?? '').trim().toLowerCase() === 'api'
  ) {
    throw new PromptValidationError('API engine is disabled in this branch. Browser execution is required.');
  }
  const resolvedEngine = resolveEngineWithConfig({ engine, configEngine: userConfig?.engine, env });
  const requestedModelList = Array.isArray(models) ? models : [];
  const normalizedRequestedModels = requestedModelList.map((entry) => normalizeModelOption(entry)).filter(Boolean);

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || DEFAULT_MODEL;
  if (normalizedRequestedModels.length > 1) {
    throw new PromptValidationError('Multi-model execution is not supported in browser-only mode.');
  }

  const selectedRawModel =
    normalizedRequestedModels.length === 0 ? cliModelArg : normalizedRequestedModels[0] ?? DEFAULT_MODEL;
  const inferredModel = inferModelFromLabel(selectedRawModel);
  // Browser engine maps Pro/legacy aliases to the latest ChatGPT picker targets (GPT-5.2 / GPT-5.2 Pro).
  const resolvedModel = normalizeChatGptModelForBrowser(inferredModel);
  const isBrowserCompatible = (m: string) =>
    (m.startsWith('gpt-') && !m.includes('codex')) || m.startsWith('gemini') || m.startsWith('grok');
  if (!isBrowserCompatible(resolvedModel)) {
    throw new PromptValidationError(
      'Browser-only mode supports GPT, Gemini, and Grok models only.',
      { engine: 'browser' },
    );
  }

  const isGrok = resolvedModel.startsWith('grok');
  const baseUrl = normalizeBaseUrl(
    userConfig?.apiBaseUrl ??
      (isGrok ? env.XAI_BASE_URL : env.OPENAI_BASE_URL),
  );

  const promptWithSuffix =
    userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
      ? `${prompt.trim()}\n${userConfig.promptSuffix}`
      : prompt;

  const search = userConfig?.search !== 'off';

  const heartbeatIntervalMs =
    userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;

  const effectiveModelId = resolveEffectiveModelId(resolvedModel);
  const runModelList = normalizedRequestedModels.length > 0 ? [resolvedModel] : undefined;

  const runOptions: RunOracleOptions = {
    prompt: promptWithSuffix,
    model: resolvedModel,
    models: runModelList && runModelList.length > 0 ? runModelList : undefined,
    file: files ?? [],
    search,
    heartbeatIntervalMs,
    filesReport: userConfig?.filesReport,
    background: userConfig?.background,
    baseUrl,
    effectiveModelId,
  };

  return { runOptions, resolvedEngine: 'browser' };
}

function resolveEngineWithConfig({
  engine,
  configEngine,
  env,
}: {
  engine?: EngineMode;
  configEngine?: EngineMode;
  env: NodeJS.ProcessEnv;
}): EngineMode {
  if (engine === 'api' || configEngine === 'api' || (env.ORACLE_ENGINE ?? '').trim().toLowerCase() === 'api') {
    throw new PromptValidationError('API engine is disabled in this branch. Browser execution is required.');
  }
  if (engine) return engine;
  if (configEngine) return configEngine;
  return resolveEngine({ engine: undefined, env });
}

function resolveEffectiveModelId(model: ModelName): string {
  if (typeof model === 'string' && model.startsWith('gemini')) {
    return resolveGeminiModelId(model);
  }
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  return config?.apiModel ?? model;
}
