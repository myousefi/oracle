import { describe, expect, test, vi } from "vitest";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";

describe('promptComposer', () => {
  test('returns immediately when ChatGPT web search chip is already selected', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'selected' } } }),
    } as unknown as { evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown> };

    await expect(promptComposer.ensureChatGptSearchEnabled(runtime as never)).resolves.toBeUndefined();
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test('opens menu and enables ChatGPT web search before resolving', async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: 'opened-menu' } } })
        .mockResolvedValueOnce({ result: { value: { status: 'clicked-search' } } })
        .mockResolvedValueOnce({ result: { value: { status: 'selected' } } }),
    } as unknown as { evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown> };

    await expect(promptComposer.ensureChatGptSearchEnabled(runtime as never)).resolves.toBeUndefined();
    expect(runtime.evaluate).toHaveBeenCalledTimes(3);
  });

  test('throws when add files and more button is missing', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'button-missing' } } }),
    } as unknown as { evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown> };

    await expect(promptComposer.ensureChatGptSearchEnabled(runtime as never)).rejects.toThrow(/Add files and more/i);
  });

  test('does not treat cleared composer + stop button as committed without a new turn', async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: false,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("allows prompt match even if baseline turn count cannot be read", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read fails
        .mockRejectedValueOnce(new Error("turn read failed"))
        // First poll shows prompt match (baseline unknown)
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: true,
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(1);
  });
});
