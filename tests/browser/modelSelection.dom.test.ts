import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildModelSelectionExpressionForTest } from "../../src/browser/actions/modelSelection.js";

async function evaluateModelSelection(html: string, targetModel: string) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://chatgpt.com/g/g-p-696bd73a78648191ac28f546046ed9ab/project",
  });
  try {
    const expression = buildModelSelectionExpressionForTest(targetModel);
    return await Promise.race([
      Promise.resolve(dom.window.eval(expression)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for model selection")), 750),
      ),
    ]);
  } finally {
    dom.window.close();
  }
}

describe("browser model selection DOM heuristics", () => {
  it("treats a generic Pro button label as already selected", async () => {
    const result = await evaluateModelSelection(
      `
        <button class="__composer-pill" aria-haspopup="menu" type="button">Pro</button>
      `,
      "GPT-5.5 Pro",
    );
    expect(result).toEqual({ status: "already-selected", label: "Pro" });
  });

  it("treats the current Extended Pro button label as already selected", async () => {
    const result = await evaluateModelSelection(
      `
        <button class="__composer-pill" aria-haspopup="menu" type="button">Extended Pro</button>
      `,
      "GPT-5.5 Pro",
    );
    expect(result).toEqual({ status: "already-selected", label: "Extended Pro" });
  });

  it("recognizes the trailing svg indicator on the selected picker item", async () => {
    const result = await evaluateModelSelection(
      `
        <button class="__composer-pill" aria-haspopup="menu" type="button">ChatGPT</button>
        <div role="menu">
          <div role="menuitem" data-testid="model-switcher-gpt-5-3">
            <div class="min-w-0">
              <span>Instant</span>
              <div>For everyday chats</div>
            </div>
            <div class="trailing" data-trailing-style="default"><span class="icon"></span></div>
          </div>
          <div role="menuitemradio" data-testid="model-switcher-gpt-5-5-thinking" aria-checked="false">
            <div class="min-w-0">
              <span>Thinking</span>
              <div>Standard</div>
            </div>
            <div class="trailing" data-trailing-style="default"><span class="icon"></span></div>
          </div>
          <div role="menuitemradio" data-testid="model-switcher-gpt-5-5-pro" aria-checked="true">
            <div class="min-w-0">
              <span>Pro</span>
              <div>Extended</div>
            </div>
            <div class="trailing" data-trailing-style="default"><svg></svg></div>
          </div>
        </div>
      `,
      "GPT-5.5 Pro",
    );
    expect(result).toMatchObject({ status: "already-selected" });
    expect(String((result as { label?: string }).label)).toContain("Pro");
    expect(String((result as { label?: string }).label)).toContain("Extended");
  });
});
