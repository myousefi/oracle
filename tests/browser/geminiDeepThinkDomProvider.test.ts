import { describe, expect, it, vi, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { geminiDeepThinkDomProvider } from "../../src/browser/providers/index.js";

describe("geminiDeepThinkDomProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses inputTimeoutMs for UI readiness", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await expect(
      geminiDeepThinkDomProvider.waitForUi({
        prompt: "hello",
        evaluate: async <T>() => ({ ready: false, requiresLogin: false }) as T,
        delay: async (ms) => {
          now += ms;
        },
        state: { inputTimeoutMs: 2_000 },
      }),
    ).rejects.toThrow("Timed out waiting for Gemini UI prompt input to become ready.");
  });

  it("selects the current Gemini Thinking mode picker", async () => {
    const dom = new JSDOM(
      `
        <button aria-label="Open mode picker" class="input-area-switch mat-mdc-menu-trigger">Fast</button>
        <div role="menu">
          <button role="menuitem" id="thinking">Thinking <span>Solves complex problems</span></button>
        </div>
      `,
      { runScripts: "dangerously", url: "https://gemini.google.com/app" },
    );
    const button = dom.window.document.querySelector("button.input-area-switch") as HTMLElement;
    const thinking = dom.window.document.querySelector("#thinking") as HTMLElement;
    thinking.addEventListener("click", () => {
      button.textContent = "Thinking";
    });

    await geminiDeepThinkDomProvider.selectMode?.({
      prompt: "hi",
      evaluate: async (expression) => dom.window.eval(expression),
      delay: async () => undefined,
    });

    expect(button.textContent).toBe("Thinking");
    dom.window.close();
  });

  it("uses timeoutMs for response polling", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await expect(
      geminiDeepThinkDomProvider.waitForResponse({
        prompt: "hello",
        evaluate: async <T>() => JSON.stringify({ status: "generating" }) as T,
        delay: async (ms) => {
          now += ms;
        },
        state: { timeoutMs: 4_000 },
      }),
    ).rejects.toThrow("Deep Think timed out waiting for response (4 seconds).");
  });
});
