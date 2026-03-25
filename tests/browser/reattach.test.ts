import { describe, expect, test, vi } from 'vitest';
import { resumeBrowserSession, __test__ } from '../../src/browser/reattach.js';
import type { BrowserLogger, ChromeClient } from '../../src/browser/types.js';

type FakeTarget = { targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: { expression: string; returnByValue?: boolean }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  close: () => Promise<void> | void;
};

describe('resumeBrowserSession', () => {
  test('selects target and captures markdown via stubs', async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: '127.0.0.1',
      chromeTargetId: 'target-1',
      tabUrl: 'https://chatgpt.com/c/abc',
    };
    const listTargets = vi.fn(async () =>
      [
        { targetId: 'target-1', type: 'page', url: runtime.tabUrl },
        { targetId: 'target-2', type: 'page', url: 'about:blank' },
      ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === 'location.href') {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === '1+1') {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(async () =>
      ({
        // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
        Runtime: { enable: vi.fn(), evaluate },
        // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
        DOM: { enable: vi.fn() },
        close: vi.fn(async () => {}),
      } satisfies FakeClient),
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: 'Hello PATH plan',
      html: '',
      meta: { messageId: 'm1', turnId: 'conversation-turn-1' },
    }));
    const captureAssistantMarkdown = vi.fn(async () => 'markdown response');
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000 },
      logger,
      { listTargets, connect, waitForAssistantResponse, captureAssistantMarkdown },
    );

    expect(result.answerMarkdown).toBe('markdown response');
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 51559, target: 'target-1' }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
  });

  test('falls back to recovery when chrome port is missing', async () => {
    const runtime = {
      tabUrl: 'https://chatgpt.com/c/abc',
    };
    const recoverSession = vi.fn(async () => ({
      answerText: 'fallback',
      answerMarkdown: 'fallback-md',
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe('fallback-md');
    expect(recoverSession).toHaveBeenCalled();
  });

  test('falls back to recovery when existing chrome attach fails', async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: '127.0.0.1',
    };
    const listTargets = vi.fn(async () => {
      throw new Error('no targets');
    }) as unknown as () => Promise<FakeTarget[]>;
    const recoverSession = vi.fn(async () => ({
      answerText: 'fallback',
      answerMarkdown: 'fallback-md',
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { listTargets, recoverSession });

    expect(result.answerText).toBe('fallback');
    expect(recoverSession).toHaveBeenCalled();
  });

  test('reopens the intended conversation when only tabUrl provides the conversation id', async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: '127.0.0.1',
      tabUrl: 'https://chatgpt.com/c/abc',
    };
    let currentUrl = 'https://chatgpt.com/c/wrong';
    let pendingUrl: string | null = null;
    const listTargets = vi.fn(async () =>
      [{ targetId: 'target-1', type: 'page', url: currentUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === 'location.href') {
        const value = currentUrl;
        if (pendingUrl) {
          currentUrl = pendingUrl;
          pendingUrl = null;
        }
        return { result: { value } };
      }
      if (expression === '1+1') {
        return { result: { value: 2 } };
      }
      if (expression.includes('const conversationId = "abc"')) {
        pendingUrl = runtime.tabUrl;
        return { result: { value: { ok: true, href: runtime.tabUrl, count: 1 } } };
      }
      if (expression.includes('document.querySelectorAll')) {
        return { result: { value: 1 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(async () =>
      ({
        Runtime: { enable: vi.fn(), evaluate },
        DOM: { enable: vi.fn() },
        close: vi.fn(async () => {}),
      } satisfies FakeClient),
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: 'Recovered from the right conversation',
      html: '',
      meta: { messageId: 'm1', turnId: 'conversation-turn-1' },
    }));
    const captureAssistantMarkdown = vi.fn(async () => 'Recovered from the right conversation');
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000 },
      logger,
      { listTargets, connect, waitForAssistantResponse, captureAssistantMarkdown },
    );

    expect(result.answerMarkdown).toContain('Recovered from the right conversation');
    expect(
      evaluate.mock.calls.some(
        ([params]) =>
          typeof params?.expression === 'string' && params.expression.includes('const conversationId = "abc"'),
      ),
    ).toBe(true);
  });

  test('recovers the original assistant turn by matching the stored prompt before reading the latest reply', async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: '127.0.0.1',
      tabUrl: 'https://chatgpt.com/c/chapter-1',
    };
    const listTargets = vi.fn(async () =>
      [{ targetId: 'target-1', type: 'page', url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === 'location.href') {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === '1+1') {
        return { result: { value: 2 } };
      }
      if (expression.includes('promptNeedles') && expression.includes('chapter 1')) {
        return {
          result: {
            value: {
              text: 'Recovered chapter 1 body',
              html: '<p>Recovered chapter 1 body</p>',
              messageId: 'assistant-original',
              turnId: 'assistant-original-turn',
            },
          },
        };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(async () =>
      ({
        Runtime: { enable: vi.fn(), evaluate },
        DOM: { enable: vi.fn() },
        close: vi.fn(async () => {}),
      } satisfies FakeClient),
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: 'Latest follow-up reply',
      html: '',
      meta: { messageId: 'm-latest', turnId: 'conversation-turn-latest' },
    }));
    const captureAssistantMarkdown = vi.fn(async () => 'Recovered chapter 1 markdown');
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        promptText:
          'You are writing a serious technical book. Now write Chapter 1: What Serverless GPU Inference Must Ultimately Reduce To.',
      },
    );

    expect(result.answerMarkdown).toBe('Recovered chapter 1 markdown');
    expect(result.response).toMatchObject({
      status: 'completed',
      messageId: 'assistant-original',
      turnId: 'assistant-original-turn',
      conversationId: 'chapter-1',
    });
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
  });
});

describe('reattach helpers', () => {
  const { pickTarget, extractConversationIdFromUrl, buildConversationUrl, openConversationFromSidebar } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test('extracts conversation id from a chat URL', () => {
    expect(extractConversationIdFromUrl('https://chatgpt.com/c/abc-123')).toBe('abc-123');
    expect(extractConversationIdFromUrl('')).toBeUndefined();
  });

  test('builds conversation URL from tabUrl or conversationId', () => {
    expect(
      buildConversationUrl({ tabUrl: 'https://chatgpt.com/c/live', conversationId: 'ignored' }, 'https://chatgpt.com/'),
    ).toBe('https://chatgpt.com/c/live');
    expect(buildConversationUrl({ conversationId: 'abc' }, 'https://chatgpt.com/')).toBe('https://chatgpt.com/c/abc');
  });

  test('pickTarget prefers chromeTargetId, then tabUrl, then first page', () => {
    const targets = [
      { targetId: 't-1', type: 'page', url: 'https://chatgpt.com/c/first' },
      { targetId: 't-2', type: 'page', url: 'https://chatgpt.com/c/second' },
      { targetId: 't-3', type: 'page', url: 'about:blank' },
    ];
    expect(pickTarget(targets, { chromeTargetId: 't-2' })).toEqual(targets[1]);
    expect(pickTarget(targets, { tabUrl: 'https://chatgpt.com/c/first' })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test('openConversationFromSidebar passes conversationId and projects preference', async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: 'https://chatgpt.com/c/abc', count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient['Runtime'];

    const ok = await openConversationFromSidebar(runtime, { conversationId: 'abc', preferProjects: true });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain('const preferProjects = true');
  });

  test('openConversationFromSidebar handles missing conversationId', async () => {
    const evaluate = vi.fn<(params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>>(
      async () => ({
        result: { value: { ok: false, count: 0 } },
      }),
    );
    const runtime = { evaluate } as unknown as ChromeClient['Runtime'];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = null');
    expect(call?.expression).toContain('const preferProjects = false');
  });
});
