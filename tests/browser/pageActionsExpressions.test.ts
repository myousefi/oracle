import { describe, expect, test } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildAssistantExtractorForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
} from '../../src/browser/pageActions.ts';
import { __test__ as reattachHelpersTest } from '../../src/browser/reattachHelpers.ts';
import { CONVERSATION_TURN_SELECTOR, ASSISTANT_ROLE_SELECTOR } from '../../src/browser/constants.ts';

describe("browser automation expressions", () => {
  test("assistant extractor references constants", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(JSON.stringify(ASSISTANT_ROLE_SELECTOR));
  });

  test("conversation debug expression references conversation selector", () => {
    const expression = buildConversationDebugExpressionForTest();
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test("markdown fallback filters user turns and respects assistant indicators", () => {
    const expression = buildMarkdownFallbackExtractorForTest("2");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
    expect(expression).toContain("role !== 'user'");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain(CONVERSATION_TURN_SELECTOR);
  });

  test("markdown fallback does not self-reference MIN_TURN_INDEX literal", () => {
    const expression = buildMarkdownFallbackExtractorForTest("MIN_TURN_INDEX");
    expect(expression).toContain("MIN_TURN_INDEX");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
  });

  test("copy expression scopes to assistant turn buttons", () => {
    const expression = buildCopyExpressionForTest({});
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(ASSISTANT_ROLE_SELECTOR);
    expect(expression).toContain("isAssistantTurn");
    expect(expression).toContain("copy-turn-action-button");
  });

  test('copy expression scopes messageId lookups to the enclosing conversation turn', () => {
    const expression = buildCopyExpressionForTest({ messageId: 'assistant-original' });
    expect(expression).toContain('[data-message-id="');
    expect(expression).toContain('closest?.(');
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test('assistant extractor prefers the final answer block over earlier thinking summaries in project view', () => {
    const dom = new JSDOM(
      `
        <body>
          <article data-testid="conversation-turn-4" data-turn="assistant">
            <div class="markdown prose">I’m treating this as a full mechanism-level reconstruction.</div>
            <div class="markdown prose">The main hinge is now pinned down.</div>
            <div class="markdown prose">I’m now testing adjacent architectures.</div>
            <div class="markdown prose">
              <h2>Chapter 16: The Anatomy of Diffusion and Multimodal Serving</h2>
              <p>All inference-serving problems differ only by model size.</p>
              <p>This is the full answer body, not the thinking summary.</p>
            </div>
          </article>
        </body>
      `,
      { runScripts: 'dangerously' },
    );
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
    });

    const expression = buildAssistantExtractorForTest('capture');
    const result = dom.window.eval(`(() => { ${expression}; return capture(); })()`) as { text?: string } | null;

    expect(result?.text).toContain('Chapter 16: The Anatomy of Diffusion and Multimodal Serving');
    expect(result?.text).toContain('This is the full answer body');
    expect(result?.text).not.toBe('I’m treating this as a full mechanism-level reconstruction.');
  });

  test('conversation recovery expression returns the assistant turn immediately after the matched prompt', () => {
    const dom = new JSDOM(
      `
        <body>
          <main>
            <article data-testid="conversation-turn-1" data-turn="user">
              <div data-message-author-role="user">
                You are writing a serious technical book.
                Now write Chapter 1: What Serverless GPU Inference Must Ultimately Reduce To.
                Additional chapter-specific requirements:
                Open from the naive belief that the platform is basically an API endpoint.
              </div>
            </article>
            <article data-testid="conversation-turn-2" data-turn="assistant">
              <div data-message-author-role="assistant" data-message-id="assistant-original" data-testid="assistant-original-turn">
                <div class="markdown prose">
                  Chapter 1 begins from the apparent simplicity of an API call and then reduces that illusion back to processes, memory, files, sockets, and devices.
                </div>
              </div>
            </article>
            <article data-testid="conversation-turn-3" data-turn="user">
              <div data-message-author-role="user">
                Can you tighten the opening page and make the ending more forceful?
              </div>
            </article>
            <article data-testid="conversation-turn-4" data-turn="assistant">
              <div data-message-author-role="assistant" data-message-id="assistant-latest" data-testid="assistant-latest-turn">
                <div class="markdown prose">
                  This is only the latest follow-up reply and should not be recovered as the canonical chapter draft.
                </div>
              </div>
            </article>
          </main>
        </body>
      `,
      { runScripts: 'dangerously' },
    );
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
    });

    const expression = reattachHelpersTest.buildConversationRecoveryExpression({
      promptNeedles: [
        'now write chapter 1: what serverless gpu inference must ultimately reduce to additional chapter-specific requirements: open from the naive belief that the platform is basically an api endpoint.',
      ],
    });
    const result = dom.window.eval(expression) as { text?: string; messageId?: string; turnId?: string } | null;

    expect(result?.messageId).toBe('assistant-original');
    expect(result?.turnId).toBe('assistant-original-turn');
    expect(result?.text).toContain('Chapter 1 begins from the apparent simplicity of an API call');
    expect(result?.text).not.toContain('latest follow-up reply');
  });

  test('conversation recovery expression recognizes article turns labeled by You said and ChatGPT said', () => {
    const dom = new JSDOM(
      `
        <body>
          <main>
            <article>
              <h5>You said:</h5>
              <div class="text-base">
                You are writing a serious technical book.
                Now write Chapter 16: The Anatomy of Diffusion and Multimodal Serving.
                Additional chapter-specific requirements:
                Open from the belief that all inference-serving problems differ only by model size.
              </div>
            </article>
            <article>
              <h6>ChatGPT said:</h6>
              <div class="text-base" data-message-id="assistant-16">
                <div class="markdown prose">
                  Chapter 16 is not just a larger version of LLM serving; it changes the execution anatomy the platform must manage.
                </div>
              </div>
            </article>
            <article>
              <h5>You said:</h5>
              <div class="text-base">
                Make the ending harder and add more on graph capture.
              </div>
            </article>
            <article>
              <h6>ChatGPT said:</h6>
              <div class="text-base" data-message-id="assistant-followup">
                <div class="markdown prose">
                  This is the later follow-up and should not be selected.
                </div>
              </div>
            </article>
          </main>
        </body>
      `,
      { runScripts: 'dangerously' },
    );
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
    });

    const expression = reattachHelpersTest.buildConversationRecoveryExpression({
      promptNeedles: [
        'now write chapter 16 the anatomy of diffusion and multimodal serving additional chapter specific requirements open from the belief that all inference serving problems differ only by model size',
      ],
    });
    const result = dom.window.eval(expression) as { text?: string; messageId?: string } | null;

    expect(result?.text).toContain('Chapter 16 is not just a larger version of LLM serving');
    expect(result?.text).not.toContain('later follow-up');
  });

  test('conversation recovery prefers the original chapter prompt over a later follow-up that repeats weaker prompt fragments', () => {
    const dom = new JSDOM(
      `
        <body>
          <main>
            <article data-testid="conversation-turn-1" data-turn="user">
              <div data-message-author-role="user">
                You are writing a serious technical book.
                The book is titled: From Linux to Serverless GPU Inference.
                Now write Chapter 16: The Anatomy of Diffusion and Multimodal Serving.
                Additional chapter-specific requirements:
                Open from the belief that all inference-serving problems differ only by model size.
              </div>
            </article>
            <article data-testid="conversation-turn-2" data-turn="assistant">
              <div data-message-author-role="assistant" data-message-id="assistant-original">
                <div class="markdown prose">
                  Chapter 16: The Anatomy of Diffusion and Multimodal Serving.
                  This is the original chapter draft.
                </div>
              </div>
            </article>
            <article data-testid="conversation-turn-3" data-turn="user">
              <div data-message-author-role="user">
                You are not allowed to give a quick answer.
                I still want a maximal-depth technical investigation.
                The book is titled: From Linux to Serverless GPU Inference.
                Now write Chapter 16: The Anatomy of Diffusion and Multimodal Serving.
                Additional chapter-specific requirements:
                Open from the belief that all inference-serving problems differ only by model size.
                Revisit the line about all inference-serving problems differing only by model size.
              </div>
            </article>
            <article data-testid="conversation-turn-4" data-turn="assistant">
              <div data-message-author-role="assistant" data-message-id="assistant-followup">
                <div class="markdown prose">
                  This is the later follow-up response and must not be selected.
                </div>
              </div>
            </article>
          </main>
        </body>
      `,
      { runScripts: 'dangerously' },
    );
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
    });

    const expression = reattachHelpersTest.buildConversationRecoveryExpression({
      promptNeedles: [
        'from linux to serverless gpu inference',
        'now write chapter 16 the anatomy of diffusion and multimodal serving',
        'open from the belief that all inference serving problems differ only by model size',
      ],
    });
    const result = dom.window.eval(expression) as { text?: string; messageId?: string; turnId?: string } | null;

    expect(result?.messageId).toBe('assistant-original');
    expect(result?.turnId).toBe('conversation-turn-2');
    expect(result?.text).toContain('This is the original chapter draft');
    expect(result?.text).not.toContain('later follow-up response');
  });
});
