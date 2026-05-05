import { countTokens as countTokensGpt5 } from "gpt-tokenizer/model/gpt-5";
import { countTokens as countTokensGpt5Pro } from "gpt-tokenizer/model/gpt-5-pro";
import type { ModelConfig, ModelName, KnownModelName, ProModelName, TokenizerFn } from "./types.js";
import { countTokens as countTokensAnthropicRaw } from "@anthropic-ai/tokenizer";
import { stringifyTokenizerInput } from "./tokenStringifier.js";

export const DEFAULT_MODEL: ModelName = "gpt-5.5-pro";
export const CURRENT_GPT_MODEL: ModelName = "gpt-5.5";
export const CURRENT_GPT_THINKING_MODEL: ModelName = "gpt-5.5-thinking";
export const CURRENT_GPT_INSTANT_MODEL: ModelName = "gpt-5.3-instant";
export const CURRENT_GPT_PRO_MODEL: ModelName = "gpt-5.5-pro";

export const PRO_MODELS = new Set<ProModelName>([
  "gpt-5.5-pro",
  "gpt-5.4-pro",
  "gpt-5.1-pro",
  "gpt-5-pro",
  "gpt-5.2-pro",
  "claude-4.5-sonnet",
  "claude-4.1-opus",
]);

const countTokensAnthropic: TokenizerFn = (input: unknown): number =>
  countTokensAnthropicRaw(stringifyTokenizerInput(input));

const GPT_INPUT_LIMIT = 196_000;
const GPT_BASE_PRICING = {
  inputPerToken: 1.75 / 1_000_000,
  outputPerToken: 14 / 1_000_000,
};
const GPT_PRO_PRICING = {
  inputPerToken: 21 / 1_000_000,
  outputPerToken: 168 / 1_000_000,
};
const GEMINI_3_INPUT_LIMIT = 1_048_576;
const GEMINI_3_PRO_PRICING = {
  inputPerToken: 2 / 1_000_000,
  outputPerToken: 12 / 1_000_000,
};
const GEMINI_3_FLASH_PRICING = {
  inputPerToken: 0.5 / 1_000_000,
  outputPerToken: 3 / 1_000_000,
};
const GEMINI_3_FLASH_LITE_PRICING = {
  inputPerToken: 0.25 / 1_000_000,
  outputPerToken: 1.5 / 1_000_000,
};
const GROK_INPUT_LIMIT = 2_000_000;

export const MODEL_CONFIGS: Record<KnownModelName, ModelConfig> = {
  "gpt-5.5-pro": {
    model: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_PRO_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.4-pro": {
    model: "gpt-5.4-pro",
    apiModel: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_PRO_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.1-pro": {
    model: "gpt-5.1-pro",
    apiModel: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_PRO_PRICING,
    reasoning: null,
  },
  "gpt-5-pro": {
    model: "gpt-5-pro",
    apiModel: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_PRO_PRICING,
    reasoning: null,
  },
  "gpt-5.5": {
    model: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.5-thinking": {
    model: "gpt-5.5-thinking",
    apiModel: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.4": {
    model: "gpt-5.4",
    apiModel: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.4-thinking": {
    model: "gpt-5.4-thinking",
    apiModel: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.3-instant": {
    model: "gpt-5.3-instant",
    apiModel: "gpt-5.3-chat-latest",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: null,
  },
  "gpt-5.1": {
    model: "gpt-5.1",
    apiModel: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "high" },
  },
  "gpt-5.1-codex": {
    model: "gpt-5.1-codex",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "high" },
  },
  "gpt-5.2": {
    model: "gpt-5.2",
    apiModel: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.2-instant": {
    model: "gpt-5.2-instant",
    apiModel: "gpt-5.3-instant",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: null,
  },
  "gpt-5.2-pro": {
    model: "gpt-5.2-pro",
    apiModel: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_PRO_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.2-thinking": {
    model: "gpt-5.2-thinking",
    apiModel: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_INPUT_LIMIT,
    pricing: GPT_BASE_PRICING,
    reasoning: { effort: "xhigh" },
  },
  "gemini-3.1-pro": {
    model: "gemini-3.1-pro",
    apiModel: "gemini-3.1-pro-preview",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GEMINI_3_INPUT_LIMIT,
    pricing: GEMINI_3_PRO_PRICING,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "gemini-3-pro": {
    model: "gemini-3-pro",
    apiModel: "gemini-3.1-pro-preview",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GEMINI_3_INPUT_LIMIT,
    pricing: GEMINI_3_PRO_PRICING,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "gemini-3-flash": {
    model: "gemini-3-flash",
    apiModel: "gemini-3-flash-preview",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GEMINI_3_INPUT_LIMIT,
    pricing: GEMINI_3_FLASH_PRICING,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "gemini-3.1-flash-lite": {
    model: "gemini-3.1-flash-lite",
    apiModel: "gemini-3.1-flash-lite-preview",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GEMINI_3_INPUT_LIMIT,
    pricing: GEMINI_3_FLASH_LITE_PRICING,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "claude-4.5-sonnet": {
    model: "claude-4.5-sonnet",
    apiModel: "claude-sonnet-4-5",
    provider: "anthropic",
    tokenizer: countTokensAnthropic,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 3 / 1_000_000,
      outputPerToken: 15 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: false,
  },
  "claude-4.1-opus": {
    model: "claude-4.1-opus",
    apiModel: "claude-opus-4-1",
    provider: "anthropic",
    tokenizer: countTokensAnthropic,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 75 / 1_000_000,
    },
    reasoning: { effort: "high" },
    supportsBackground: false,
    supportsSearch: false,
  },
  "grok-4.3": {
    model: "grok-4.3",
    provider: "xai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GROK_INPUT_LIMIT,
    pricing: null,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
    searchToolType: "web_search",
  },
  "grok-4-1-fast": {
    model: "grok-4-1-fast",
    provider: "xai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GROK_INPUT_LIMIT,
    pricing: null,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
    searchToolType: "web_search",
  },
  "grok-4.20-multi-agent": {
    model: "grok-4.20-multi-agent",
    provider: "xai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GROK_INPUT_LIMIT,
    pricing: null,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
    searchToolType: "web_search",
  },
  "grok-4.20": {
    model: "grok-4.20",
    apiModel: "grok-4.20-multi-agent",
    provider: "xai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: GROK_INPUT_LIMIT,
    pricing: null,
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
    searchToolType: "web_search",
  },
};

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Oracle, a focused one-shot problem solver.",
  "Emphasize direct answers and cite any files referenced.",
].join(" ");

export const TOKENIZER_OPTIONS = { allowedSpecial: "all" } as const;
