import type { BrowserLogger, ChromeClient } from "./types.js";
import { CONVERSATION_TURN_SELECTOR } from "./constants.js";
import { delay } from "./utils.js";
import { readAssistantSnapshot } from "./pageActions.js";

export type TargetInfoLite = {
  targetId?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

export type AssistantPayload = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

type PromptEchoMatcher = { isEcho: (text: string) => boolean };

export function pickTarget(
  targets: TargetInfoLite[],
  runtime: { chromeTargetId?: string; tabUrl?: string },
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) {
    return undefined;
  }
  if (runtime.chromeTargetId) {
    const byId = targets.find((t) => t.targetId === runtime.chromeTargetId);
    if (byId) return byId;
  }
  if (runtime.tabUrl) {
    const byUrl =
      targets.find((t) => t.url?.startsWith(runtime.tabUrl as string)) ||
      targets.find((t) => (runtime.tabUrl as string).startsWith(t.url || ""));
    if (byUrl) return byUrl;
  }
  return targets.find((t) => t.type === "page") ?? targets[0];
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

export function buildConversationUrl(
  runtime: { tabUrl?: string; conversationId?: string },
  baseUrl: string,
): string | null {
  if (runtime.tabUrl) {
    if (runtime.tabUrl.includes("/c/")) {
      return runtime.tabUrl;
    }
    return null;
  }
  const conversationId = runtime.conversationId;
  if (!conversationId) {
    return null;
  }
  try {
    const base = new URL(baseUrl);
    const pathRoot = base.pathname.replace(/\/$/, "");
    const prefix = pathRoot === "/" ? "" : pathRoot;
    return `${base.origin}${prefix}/c/${conversationId}`;
  } catch {
    return null;
  }
}

export async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export async function openConversationFromSidebar(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  attempt = 0,
): Promise<boolean> {
  const response = await Runtime.evaluate({
    expression: `(() => {
      const conversationId = ${JSON.stringify(options.conversationId ?? null)};
      const preferProjects = ${JSON.stringify(Boolean(options.preferProjects))};
      const promptPreview = ${JSON.stringify(options.promptPreview ?? null)};
      const attemptIndex = ${Math.max(0, attempt)};
      const promptNeedleFull = promptPreview ? promptPreview.trim().toLowerCase().slice(0, 100) : '';
      const promptNeedleShort = promptNeedleFull.replace(/\\s*\\d{4,}\\s*$/, '').trim();
      const promptNeedles = Array.from(new Set([promptNeedleFull, promptNeedleShort].filter(Boolean)));
      const nav = document.querySelector('nav') || document.querySelector('aside') || document.body;
      if (preferProjects) {
        const projectLink = Array.from(nav.querySelectorAll('a,button'))
          .find((el) => (el.textContent || '').trim().toLowerCase() === 'projects');
        if (projectLink) {
          projectLink.click();
        }
      }
      const allElements = Array.from(
        document.querySelectorAll(
          'a,button,[role="link"],[role="button"],[data-href],[data-url],[data-conversation-id],[data-testid*="conversation"],[data-testid*="history"]',
        ),
      );
      const getHref = (el) =>
        el.getAttribute('href') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-url') ||
        el.dataset?.href ||
        el.dataset?.url ||
        '';
      const toCandidate = (el) => {
        const clickable = el.closest('a,button,[role="link"],[role="button"]') || el;
        const rawText = (el.textContent || clickable.textContent || '').trim();
        return {
          el,
          clickable,
          href: getHref(clickable) || getHref(el),
          conversationId:
            clickable.getAttribute('data-conversation-id') ||
            el.getAttribute('data-conversation-id') ||
            clickable.dataset?.conversationId ||
            el.dataset?.conversationId ||
            '',
          testId: clickable.getAttribute('data-testid') || el.getAttribute('data-testid') || '',
          text: rawText.replace(/\\s+/g, ' ').slice(0, 400),
          inNav: Boolean(clickable.closest('nav,aside')),
        };
      };
      const candidates = allElements.map(toCandidate);
      const mainCandidates = candidates.filter((item) => !item.inNav);
      const navCandidates = candidates.filter((item) => item.inNav);
      const visible = (item) => {
        const rect = item.clickable.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pick = (items) => (items.find(visible) || items[0] || null);
      const pickWithAttempt = (items) => {
        if (!items.length) return null;
        const visibleItems = items.filter(visible);
        const pool = visibleItems.length > 0 ? visibleItems : items;
        const index = Math.min(attemptIndex, pool.length - 1);
        return pool[index] ?? null;
      };
      let target = null;
      if (conversationId) {
        const byId = (item) =>
          (item.href && item.href.includes('/c/' + conversationId)) ||
          (item.conversationId && item.conversationId === conversationId);
        target = pick(mainCandidates.filter(byId)) || pick(navCandidates.filter(byId));
      }
      if (!target && promptNeedles.length > 0) {
        const byPrompt = (item) => promptNeedles.some((needle) => item.text && item.text.toLowerCase().includes(needle));
        const sortBySpecificity = (items) =>
          items
            .filter(byPrompt)
            .sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0));
        target = pickWithAttempt(sortBySpecificity(mainCandidates)) || pickWithAttempt(sortBySpecificity(navCandidates));
      }
      if (!target) {
        const byHref = (item) => item.href && item.href.includes('/c/');
        target = pickWithAttempt(mainCandidates.filter(byHref)) || pickWithAttempt(navCandidates.filter(byHref));
      }
      if (!target) {
        const byTestId = (item) => /conversation|history/i.test(item.testId || '');
        target = pickWithAttempt(mainCandidates.filter(byTestId)) || pickWithAttempt(navCandidates.filter(byTestId));
      }
      if (target) {
        target.clickable.scrollIntoView({ block: 'center' });
        target.clickable.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
        );
        // Fallback: some project-sidebar items don't navigate on click, force the URL.
        if (target.href && target.href.includes('/c/')) {
          const targetUrl = target.href.startsWith('http')
            ? target.href
            : new URL(target.href, location.origin).toString();
          if (targetUrl && targetUrl !== location.href) {
            location.href = targetUrl;
          }
        }
        return {
          ok: true,
          href: target.href || '',
          count: candidates.length,
          scope: target.inNav ? 'nav' : 'main',
        };
      }
      return { ok: false, count: candidates.length };
    })()`,
    returnByValue: true,
  });
  return Boolean(response.result?.value?.ok);
}

export async function openConversationFromSidebarWithRetry(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    // Retry because project list can hydrate after initial navigation.
    const opened = await openConversationFromSidebar(Runtime, options, attempt);
    if (opened) {
      if (options.promptPreview) {
        const matched = await waitForPromptPreview(Runtime, options.promptPreview, 10_000);
        if (matched) {
          return true;
        }
      } else {
        return true;
      }
    }
    attempt += 1;
    await delay(attempt < 5 ? 250 : 500);
  }
  return false;
}

export async function waitForPromptPreview(
  Runtime: ChromeClient["Runtime"],
  promptPreview: string,
  timeoutMs: number,
): Promise<boolean> {
  const needleFull = promptPreview.trim().toLowerCase().slice(0, 120);
  const needleShort = needleFull.replace(/\\s*\\d{4,}\\s*$/, "").trim();
  const needles = Array.from(new Set([needleFull, needleShort].filter(Boolean)));
  if (needles.length === 0) return false;
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const expression = `(() => {
    const needles = ${JSON.stringify(needles)};
    const root =
      document.querySelector('section[data-testid="screen-threadFlyOut"]') ||
      document.querySelector('[data-testid="chat-thread"]') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]');
    if (!root) return false;
    const userTurns = Array.from(root.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
    const collectText = (nodes) =>
      nodes
        .map((node) => (node.innerText || node.textContent || ''))
        .join(' ')
        .toLowerCase();
    let text = collectText(userTurns);
    let hasTurns = userTurns.length > 0;
    if (!text) {
      const turns = Array.from(root.querySelectorAll(${selectorLiteral}));
      hasTurns = hasTurns || turns.length > 0;
      text = collectText(turns);
    }
    if (!text) {
      text = (root.innerText || root.textContent || '').toLowerCase();
    }
    return needles.some((needle) => text.includes(needle));
  })()`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await Runtime.evaluate({ expression, returnByValue: true });
      if (result?.value === true) {
        return true;
      }
    } catch {
      // ignore
    }
    await delay(300);
  }
  return false;
}

export async function waitForLocationChange(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastHref = "";
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    const href = typeof result?.value === "string" ? result.value : "";
    if (lastHref && href !== lastHref) {
      return;
    }
    lastHref = href;
    await delay(200);
  }
}

export async function readConversationTurnIndex(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  try {
    const { result } = await Runtime.evaluate({
      expression: `document.querySelectorAll(${selectorLiteral}).length`,
      returnByValue: true,
    });
    const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
    if (!Number.isFinite(raw)) {
      throw new Error("Turn count not numeric");
    }
    return Math.max(0, Math.floor(raw) - 1);
  } catch (error) {
    if (logger?.verbose) {
      logger(
        `Failed to read conversation turn index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

export async function readConversationLocation(
  Runtime: ChromeClient["Runtime"],
): Promise<{ tabUrl?: string; conversationId?: string }> {
  try {
    const { result } = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    const tabUrl = typeof result?.value === "string" ? result.value : undefined;
    return {
      tabUrl,
      conversationId: extractConversationIdFromUrl(tabUrl ?? ""),
    };
  } catch {
    return {};
  }
}

export async function recoverAssistantTurnFromConversation(
  Runtime: ChromeClient["Runtime"],
  options: {
    messageId?: string | null;
    turnId?: string | null;
    promptText?: string | null;
    promptPreview?: string | null;
  },
): Promise<AssistantPayload | null> {
  const expression = buildConversationRecoveryExpression({
    messageId: options.messageId ?? undefined,
    turnId: options.turnId ?? undefined,
    promptNeedles: buildPromptRecoveryNeedles(options.promptText, options.promptPreview),
  });
  try {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value;
    if (!value || typeof value !== "object") {
      return null;
    }
    const payload = value as {
      text?: unknown;
      html?: unknown;
      messageId?: unknown;
      turnId?: unknown;
    };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return null;
    }
    return {
      text,
      html: typeof payload.html === "string" ? payload.html : undefined,
      meta: {
        messageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
        turnId: typeof payload.turnId === "string" ? payload.turnId : undefined,
      },
    };
  } catch {
    return null;
  }
}

export async function waitForRecoveredAssistantTurn(
  Runtime: ChromeClient["Runtime"],
  options: {
    messageId?: string | null;
    turnId?: string | null;
    promptText?: string | null;
    promptPreview?: string | null;
  },
  timeoutMs: number,
): Promise<AssistantPayload | null> {
  const hasLocator = Boolean(
    options.turnId ||
    options.messageId ||
    (options.promptText && options.promptText.trim()) ||
    (options.promptPreview && options.promptPreview.trim()),
  );
  if (!hasLocator) {
    return null;
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const recovered = await recoverAssistantTurnFromConversation(Runtime, options);
    if (recovered) {
      return recovered;
    }
    await delay(300);
  }
  return null;
}

function normalizeForComparison(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\\s+/g, " ")
    .trim();
}

function normalizePromptMatchText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
}

function buildPromptRecoveryNeedles(
  promptText?: string | null,
  promptPreview?: string | null,
): string[] {
  const needles: string[] = [];
  const addNeedle = (value: string | null | undefined, maxLength = 420) => {
    const normalized = normalizePromptMatchText(value ?? "");
    if (!normalized) return;
    const trimmed = normalized.length > maxLength ? normalized.slice(-maxLength) : normalized;
    if (trimmed.length < 24) return;
    if (!needles.includes(trimmed)) {
      needles.push(trimmed);
    }
  };

  const rawPrompt = String(promptText ?? "");
  const lines = rawPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let nowWriteIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^now write\b/i.test(lines[index] ?? "")) {
      nowWriteIndex = index;
      break;
    }
  }
  if (nowWriteIndex >= 0) {
    addNeedle(lines[nowWriteIndex], 220);
    addNeedle(lines.slice(nowWriteIndex, Math.min(lines.length, nowWriteIndex + 8)).join(" "), 420);
  }
  if (lines.length > 0) {
    addNeedle(lines[lines.length - 1], 220);
    addNeedle(lines.slice(Math.max(0, lines.length - 8)).join(" "), 420);
  }

  const normalizedPrompt = normalizePromptMatchText(rawPrompt);
  if (normalizedPrompt) {
    addNeedle(normalizedPrompt.slice(-420), 420);
    addNeedle(normalizedPrompt.slice(-240), 240);
    addNeedle(normalizedPrompt.slice(-120), 120);
  }
  addNeedle(promptPreview, 160);

  return needles.slice(0, 6);
}

function buildConversationRecoveryExpression(options: {
  messageId?: string;
  turnId?: string;
  promptNeedles: string[];
}): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const hint = ${JSON.stringify(options)};
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const normalize = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    const labelText = (node) => {
      if (!(node instanceof HTMLElement)) return '';
      const heading = node.querySelector('h5, h6, [role="heading"]');
      return normalize(heading?.innerText || heading?.textContent || '');
    };
    const isUserTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'user') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'user') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('user')) return true;
      return labelText(node).includes('you said');
    };
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return labelText(node).includes('chatgpt said');
    };
    const conversationRoot = document.querySelector('main') || document.body || document;
    const compareDomOrder = (left, right) => {
      if (left === right) return 0;
      const relation = left.compareDocumentPosition(right);
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      return 0;
    };
    const conversationTurns = Array.from(
      new Set(
        [
          ...Array.from(document.querySelectorAll(CONVERSATION_SELECTOR)),
          ...Array.from(conversationRoot.querySelectorAll('article')),
        ]
          .map((node) => node?.closest?.(CONVERSATION_SELECTOR) || node?.closest?.('article') || node)
          .filter((node) => node instanceof HTMLElement),
      ),
    ).sort(compareDomOrder);
    const resolveTurnIndex = (node) => {
      const turn = node?.closest?.(CONVERSATION_SELECTOR);
      if (!turn) return null;
      const idx = conversationTurns.indexOf(turn);
      return idx >= 0 ? idx : null;
    };
    const toMessageRoot = (node, role) => {
      if (!(node instanceof HTMLElement)) return null;
      const selector =
        role === 'assistant'
          ? '[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'
          : '[data-message-author-role="user"], [data-turn="user"], [data-testid*="user"]';
      const scopedContent =
        node.querySelector(selector) ||
        node.querySelector('div[class*="text-base"], [data-message-content], .markdown, .prose') ||
        (node.matches?.(selector) ? node : node);
      return scopedContent;
    };
    const extractAssistantPayload = (node, fallbackTurnIndex = null) => {
      const messageRoot = toMessageRoot(node, 'assistant');
      if (!(messageRoot instanceof HTMLElement)) return null;
      const turnRoot =
        node?.closest?.(CONVERSATION_SELECTOR) ||
        messageRoot.closest?.(CONVERSATION_SELECTOR) ||
        node?.closest?.('article') ||
        messageRoot.closest?.('article') ||
        node;
      const selectors = [
        '.markdown',
        '[data-message-content]',
        '[data-testid*="message"]',
        '[data-testid*="assistant"]',
        '.prose',
        '[class*="markdown"]',
      ];
      const candidateRoots = [];
      if (messageRoot.matches?.('.markdown') || messageRoot.matches?.('[data-message-content]')) {
        candidateRoots.push(messageRoot);
      }
      for (const selector of selectors) {
        for (const candidate of messageRoot.querySelectorAll(selector)) {
          candidateRoots.push(candidate);
        }
      }
      const seenRoots = new Set();
      let preferred = null;
      let preferredScore = -1;
      for (const candidate of candidateRoots) {
        if (!(candidate instanceof HTMLElement) || seenRoots.has(candidate)) continue;
        seenRoots.add(candidate);
        const candidateText = ((candidate.innerText || candidate.textContent || '') + '').trim();
        if (!candidateText) continue;
        const score = candidateText.length;
        if (score >= preferredScore) {
          preferred = candidate;
          preferredScore = score;
        }
      }
      const contentRoot = preferred || messageRoot;
      const text = ((contentRoot.innerText || contentRoot.textContent || '') + '').trim();
      if (!text) return null;
      return {
        text,
        html: contentRoot.innerHTML || '',
        messageId: messageRoot.getAttribute('data-message-id'),
        turnId: messageRoot.getAttribute('data-testid') || turnRoot?.getAttribute?.('data-testid') || null,
        turnIndex: fallbackTurnIndex ?? resolveTurnIndex(messageRoot),
      };
    };

    if (hint?.messageId || hint?.turnId) {
      const exactNode =
        (hint.messageId ? document.querySelector('[data-message-id="' + hint.messageId + '"]') : null) ||
        (hint.turnId ? document.querySelector('[data-testid="' + hint.turnId + '"]') : null);
      if (exactNode) {
        const exactPayload = extractAssistantPayload(exactNode, resolveTurnIndex(exactNode));
        if (exactPayload) {
          return exactPayload;
        }
      }
    }

    const needles = Array.isArray(hint?.promptNeedles) ? hint.promptNeedles.map((needle) => normalize(needle)).filter(Boolean) : [];
    if (needles.length === 0 || conversationTurns.length === 0) {
      return null;
    }
    const chapterNeedles = needles.filter((needle) => needle.includes('now write chapter'));
    const requireChapterNeedle = chapterNeedles.length > 0;

    let bestUserIndex = -1;
    let bestStrongMatches = -1;
    let bestMatchCount = -1;
    let bestScore = -1;
    for (let index = 0; index < conversationTurns.length; index += 1) {
      const turn = conversationTurns[index];
      if (!isUserTurn(turn)) continue;
      const userRoot = toMessageRoot(turn, 'user');
      const normalizedText = normalize(userRoot?.innerText || userRoot?.textContent || '');
      if (!normalizedText) continue;
      let score = 0;
      let matchCount = 0;
      let strongMatches = 0;
      for (const needle of needles) {
        if (!needle) continue;
        let matchedLength = 0;
        if (normalizedText.includes(needle)) {
          matchedLength = needle.length;
        } else {
          const shortNeedle = needle.slice(0, Math.min(160, needle.length));
          if (shortNeedle.length >= 32 && normalizedText.includes(shortNeedle)) {
            matchedLength = shortNeedle.length;
          }
        }
        if (matchedLength <= 0) {
          continue;
        }
        score += matchedLength;
        matchCount += 1;
        if (chapterNeedles.includes(needle) && normalizedText.includes(needle)) {
          strongMatches += 1;
        }
      }
      if (requireChapterNeedle && strongMatches > 0) {
        bestUserIndex = index;
        bestStrongMatches = strongMatches;
        bestMatchCount = matchCount;
        bestScore = score;
        break;
      }
      if (requireChapterNeedle && strongMatches === 0) {
        continue;
      }
      if (matchCount <= 0) {
        continue;
      }
      if (
        strongMatches > bestStrongMatches ||
        (strongMatches === bestStrongMatches && matchCount > bestMatchCount) ||
        (strongMatches === bestStrongMatches && matchCount === bestMatchCount && score > bestScore)
      ) {
        bestStrongMatches = strongMatches;
        bestMatchCount = matchCount;
        bestUserIndex = index;
        bestScore = score;
      }
    }
    if (bestUserIndex < 0 || bestScore <= 0) {
      return null;
    }

    for (let index = bestUserIndex + 1; index < conversationTurns.length; index += 1) {
      const turn = conversationTurns[index];
      if (!isAssistantTurn(turn)) continue;
      const payload = extractAssistantPayload(turn, index);
      if (payload) {
        return payload;
      }
    }
    return null;
  })()`;
}

export function buildPromptEchoMatcher(promptPreview?: string | null): PromptEchoMatcher | null {
  const normalizedPrompt = normalizeForComparison(promptPreview ?? "");
  if (!normalizedPrompt) {
    return null;
  }
  const promptPrefix =
    normalizedPrompt.length >= 80
      ? normalizedPrompt.slice(0, Math.min(200, normalizedPrompt.length))
      : "";
  const minFragment = Math.min(40, normalizedPrompt.length);
  return {
    isEcho: (text: string) => {
      const normalized = normalizeForComparison(text);
      if (!normalized) return false;
      if (normalized === normalizedPrompt) return true;
      if (promptPrefix.length > 0 && normalized.startsWith(promptPrefix)) return true;
      if (normalized.length >= minFragment && normalizedPrompt.startsWith(normalized)) {
        return true;
      }
      if (normalized.includes("…") || normalized.includes("...")) {
        const marker = normalized.includes("…") ? "…" : "...";
        const [prefixRaw, suffixRaw] = normalized.split(marker);
        const prefix = prefixRaw?.trim() ?? "";
        const suffix = suffixRaw?.trim() ?? "";
        if (!prefix && !suffix) return false;
        if (prefix && !normalizedPrompt.includes(prefix)) return false;
        if (suffix && !normalizedPrompt.includes(suffix)) return false;
        const fragmentLength = prefix.length + suffix.length;
        return fragmentLength >= minFragment;
      }
      return false;
    },
  };
}

export async function recoverPromptEcho(
  Runtime: ChromeClient["Runtime"],
  answer: AssistantPayload,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
  minTurnIndex: number | null,
  timeoutMs: number,
): Promise<AssistantPayload> {
  if (!matcher || !matcher.isEcho(answer.text)) {
    return answer;
  }
  logger("Detected prompt echo while reattaching; waiting for assistant response...");
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestText: string | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || matcher.isEcho(text)) {
      await delay(300);
      continue;
    }
    if (!bestText || text.length > bestText.length) {
      bestText = text;
      stableCount = 0;
    } else if (text === bestText) {
      stableCount += 1;
    }
    if (stableCount >= 2) {
      break;
    }
    await delay(300);
  }
  if (bestText) {
    logger("Recovered assistant response after prompt echo during reattach");
    return { ...answer, text: bestText };
  }
  return answer;
}

export function alignPromptEchoPair(
  answerText: string,
  answerMarkdown: string,
  matcher: PromptEchoMatcher | null,
  logger?: BrowserLogger,
  messages?: { text?: string; markdown?: string },
): {
  answerText: string;
  answerMarkdown: string;
  textEcho: boolean;
  markdownEcho: boolean;
  isEcho: boolean;
} {
  if (!matcher) {
    return { answerText, answerMarkdown, textEcho: false, markdownEcho: false, isEcho: false };
  }
  let textEcho = matcher.isEcho(answerText);
  let markdownEcho = matcher.isEcho(answerMarkdown);
  if (textEcho && !markdownEcho && answerMarkdown) {
    if (logger && messages?.text) {
      logger(messages.text);
    }
    answerText = answerMarkdown;
    textEcho = false;
  }
  if (markdownEcho && !textEcho && answerText) {
    if (logger && messages?.markdown) {
      logger(messages.markdown);
    }
    answerMarkdown = answerText;
    markdownEcho = false;
  }
  return {
    answerText,
    answerMarkdown,
    textEcho,
    markdownEcho,
    isEcho: textEcho || markdownEcho,
  };
}

export function alignPromptEchoMarkdown(
  answerText: string,
  answerMarkdown: string,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
): { answerText: string; answerMarkdown: string } {
  const aligned = alignPromptEchoPair(answerText, answerMarkdown, matcher, logger, {
    text: "Aligned prompt-echo text to copied markdown during reattach",
    markdown: "Aligned prompt-echo markdown to response text during reattach",
  });
  return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
}

export const __test__ = {
  buildConversationRecoveryExpression,
};
