import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { ChromeClient } from "../../src/browser/types.js";
import {
  buildEnsureImageModeExpressionForTest,
  buildImageSnapshotExpressionForTest,
  waitForChatGptGeneratedImages,
} from "../../src/browser/pageActions.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("ChatGPT image generation browser helpers", () => {
  test("clicks the Create image menu item instead of the parent menu container", () => {
    const dom = createDom(`
      <body>
        <form>
          <div id="prompt-textarea" contenteditable="true"></div>
          <button aria-label="Add files and more" data-testid="composer-plus-btn" data-state="open"></button>
        </form>
        <div role="menu" id="menu">
          <div id="parent">Add photos & files Recent files Create image Deep research Web search More</div>
          <button id="create" role="menuitemradio" aria-checked="false">Create image</button>
        </div>
      </body>
    `);
    try {
      const createButton = dom.window.document.querySelector("#create");
      createButton?.addEventListener("click", () => {
        createButton.setAttribute("data-clicked", "true");
      });

      const result = dom.window.eval(buildEnsureImageModeExpressionForTest()) as {
        status?: string;
      };
      expect(result.status).toBe("clicked-image");
      expect(createButton?.getAttribute("data-clicked")).toBe("true");
      expect(dom.window.document.querySelector("#parent")?.getAttribute("data-clicked")).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  test("selects the requested aspect ratio through the visible aspect menu", () => {
    const dom = createDom(`
      <body>
        <form>
          <div id="prompt-textarea" contenteditable="true"></div>
          <button aria-label="Add files and more" data-testid="composer-plus-btn"></button>
          <button aria-label="Image, click to remove">Image</button>
          <button aria-label="Choose image aspect ratio">Auto</button>
        </form>
        <div role="menu">
          <button id="portrait" role="menuitemradio">Portrait 3:4</button>
        </div>
      </body>
    `);
    try {
      const portrait = dom.window.document.querySelector("#portrait");
      portrait?.addEventListener("click", () => {
        portrait.setAttribute("data-clicked", "true");
      });

      const result = dom.window.eval(buildEnsureImageModeExpressionForTest("3:4")) as {
        status?: string;
      };
      expect(result.status).toBe("selected-aspect");
      expect(portrait?.getAttribute("data-clicked")).toBe("true");
    } finally {
      dom.window.close();
    }
  });

  test("captures only generated images from the newest assistant turn", () => {
    const dom = createDom(`
      <body>
        <aside><img src="https://cdn.example/sidebar.png" /></aside>
        <form><img src="https://cdn.example/composer.png" /></form>
        <main>
          <article data-testid="conversation-turn-1" data-message-author-role="user">
            <img src="https://cdn.example/user-upload.png" />
          </article>
          <article data-testid="conversation-turn-2" data-message-author-role="assistant">
            <div data-message-author-role="assistant" data-message-id="msg-1">
              <p>Done</p>
              <img src="https://cdn.example/generated.png" alt="generated" />
            </div>
          </article>
        </main>
      </body>
    `);
    try {
      const result = dom.window.eval(buildImageSnapshotExpressionForTest(1)) as {
        images?: Array<{ src: string; width: number; height: number }>;
        messageId?: string;
      };
      expect(result.messageId).toBe("msg-1");
      expect(result.images).toEqual([
        {
          src: "https://cdn.example/generated.png",
          width: 512,
          height: 512,
          alt: "generated",
        },
      ]);
    } finally {
      dom.window.close();
    }
  });

  test("saves all downloaded images with deterministic suffixes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-images-"));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, "generated.png");
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression?: string }) => {
        const source = String(expression ?? "");
        if (source.includes("const srcs =")) {
          return {
            result: {
              value: {
                images: [
                  {
                    src: "blob:https://chatgpt.com/one",
                    mimeType: "image/png",
                    base64: Buffer.from([1, 2, 3]).toString("base64"),
                    width: 512,
                    height: 512,
                  },
                  {
                    src: "blob:https://chatgpt.com/two",
                    mimeType: "image/png",
                    base64: Buffer.from([4, 5, 6]).toString("base64"),
                    width: 512,
                    height: 512,
                  },
                ],
              },
            },
          };
        }
        if (source.includes("FINISHED_SELECTOR")) {
          return { result: { value: true } };
        }
        if (source.includes("stop-button")) {
          return { result: { value: false } };
        }
        return {
          result: {
            value: {
              text: "",
              messageId: "msg",
              turnId: "turn",
              images: [
                { src: "blob:https://chatgpt.com/one", width: 512, height: 512 },
                { src: "blob:https://chatgpt.com/two", width: 512, height: 512 },
              ],
            },
          },
        };
      }),
    } as unknown as ChromeClient["Runtime"];

    const result = await waitForChatGptGeneratedImages(runtime, outputPath, 1_000, vi.fn(), 1);

    expect(result.outputPaths).toEqual([outputPath, path.join(tempDir, "generated-2.png")]);
    expect(Array.from(await readFile(outputPath))).toEqual([1, 2, 3]);
    expect(Array.from(await readFile(path.join(tempDir, "generated-2.png")))).toEqual([4, 5, 6]);
  });
});

function createDom(html: string): JSDOM {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://chatgpt.com/",
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
    set(value: string) {
      this.textContent = value;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return { width: 512, height: 512, top: 0, left: 0, right: 512, bottom: 512 };
    },
  });
  return dom;
}
