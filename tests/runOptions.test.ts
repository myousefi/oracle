import { describe, expect, it } from 'vitest';
import { resolveRunOptionsFromConfig } from '../src/cli/runOptions.js';
import { estimateRequestTokens } from '../src/oracle/tokenEstimate.js';
import { DEFAULT_MODEL, MODEL_CONFIGS } from '../src/oracle/config.js';

describe('resolveRunOptionsFromConfig', () => {
  const basePrompt = 'This prompt is comfortably above twenty characters.';

  it('routes to browser mode by default', () => {
    const { resolvedEngine } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      env: {},
    });
    expect(resolvedEngine).toBe('browser');
  });

  it('rejects explicit --engine api', () => {
    expect(() =>
      resolveRunOptionsFromConfig({
        prompt: basePrompt,
        engine: 'api',
      }),
    ).toThrow('API engine is disabled');
  });

  it('uses config model when caller does not provide one', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { model: 'gpt-5.1' },
    });
    expect(runOptions.model).toBe('gpt-5.4');
  });

  it('defaults to gpt-5.4-pro when model not provided', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
    });
    expect(runOptions.model).toBe(DEFAULT_MODEL);
  });

  it('maps browser aliases for GPT Pro and legacy models', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'gpt-5.1-pro',
    });
    expect(runOptions.model).toBe('gpt-5.4-pro');
  });

  it('rejects multi-model lists', () => {
    expect(() =>
      resolveRunOptionsFromConfig({
        prompt: basePrompt,
        models: ['gpt-5.1', 'gemini-3-pro'],
      }),
    ).toThrow('Multi-model execution is not supported in browser-only mode.');
  });

  it('maps grok model through browser inference', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'grok',
    });
    expect(runOptions.model).toBe('grok-4.20');
  });

  it('rejects non-browser model labels', () => {
    expect(() =>
      resolveRunOptionsFromConfig({
        prompt: basePrompt,
        model: 'claude-4.5-sonnet',
      }),
    ).toThrow('Browser-only mode supports GPT, Gemini, and Grok models only.');
  });

  it('keeps browser base URL selection for grok when configured', () => {
    const env = { XAI_BASE_URL: 'https://api.example/v1' } as NodeJS.ProcessEnv;
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'grok',
      env,
    });
    expect(runOptions.baseUrl).toBe('https://api.example/v1');
  });
});

describe('estimateRequestTokens', () => {
  const modelConfig = MODEL_CONFIGS['gpt-5.1'];

  it('includes instructions, input text, tools, reasoning, background/store, plus buffer', () => {
    const request = {
      model: 'gpt-5.1',
      instructions: 'sys',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello world' }],
        },
      ],
      tools: [{ type: 'web_search_preview' }],
      reasoning: { effort: 'high' },
      background: true,
      store: true,
    };
    const estimate = estimateRequestTokens(request as unknown as Parameters<typeof estimateRequestTokens>[0], modelConfig, 10);
    expect(estimate).toBeGreaterThan(10);
  });

  it('adds buffer even with minimal input', () => {
    const request = {
      model: 'gpt-5.1',
      instructions: 'a',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'b' }] }],
    };
    const estimate = estimateRequestTokens(request as unknown as Parameters<typeof estimateRequestTokens>[0], modelConfig, 50);
    expect(estimate).toBeGreaterThanOrEqual(50);
  });
});
