import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  BrowserReport,
  BrowserReportHeading,
  BrowserReportLink,
  BrowserReportSourceGroup,
  BrowserReportTable,
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
} from "../browser/types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { DEFAULT_ORACLE_BROWSER_PROFILE_DIR } from "../browser/profileDefaults.js";
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectWithNewTab,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
  closeTab,
} from "../browser/chromeLifecycle.js";
import { syncCookies } from "../browser/cookies.js";
import { delay, estimateTokenCount } from "../browser/utils.js";
import {
  installJavaScriptDialogAutoDismissal,
  ensureNotBlocked,
} from "../browser/actions/navigation.js";
import {
  cleanupStaleProfileState,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "../browser/profileState.js";
import type { LaunchedChrome } from "chrome-launcher";
import type { GeminiWebOptions } from "./types.js";

const DEFAULT_GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_TEXTBOX_SELECTOR =
  '[role="textbox"][aria-label="Enter a prompt for Gemini"], [aria-label="Enter a prompt for Gemini"][contenteditable="true"]';
const GEMINI_SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"]';
const GEMINI_TOOLS_BUTTON_SELECTOR = 'button[aria-label="Tools"]';

interface GeminiDomButton {
  text: string;
  aria: string | null;
  disabled: boolean;
}

interface GeminiDomResponse {
  raw: string;
  buttons: GeminiDomButton[];
  hasStartResearch: boolean;
  startResearchDisabled: boolean;
}

interface GeminiResearchState {
  responses: GeminiDomResponse[];
  bodyText: string;
  stopResponseVisible: boolean;
}

interface GeminiParsedResponse {
  body: string;
  thoughts: string | null;
}

interface GeminiDomReportHeading {
  level: number;
  text: string;
}

interface GeminiDomReportTable {
  caption: string | null;
  rows: string[][];
}

interface GeminiDomReportLink {
  title: string;
  url: string;
  domain: string | null;
}

interface GeminiDomReportSourceGroup {
  title: string;
  links: GeminiDomReportLink[];
}

interface GeminiDomReportPayload {
  title: string | null;
  text: string;
  html: string;
  headings: GeminiDomReportHeading[];
  tables: GeminiDomReportTable[];
  sources: GeminiDomReportSourceGroup[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function stripGeminiWindowSuffix(value: string): string {
  return value.replace(/\bOpens in a new window\b/gi, "").trim();
}

function cleanGeminiSourceTitle(title: string, domain?: string | null): string {
  const cleaned = stripGeminiWindowSuffix(normalizeWhitespace(title));
  if (!cleaned) return domain?.trim() || "Source";
  if (domain && cleaned.toLowerCase().startsWith(domain.toLowerCase())) {
    const stripped = cleaned.slice(domain.length).trim();
    if (stripped) return stripped;
  }
  return cleaned;
}

function dedupeGeminiLinks(links: BrowserReportLink[]): BrowserReportLink[] {
  const seen = new Set<string>();
  const unique: BrowserReportLink[] = [];
  for (const link of links) {
    const key = `${link.url}::${link.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(link);
  }
  return unique;
}

export function normalizeGeminiReport(raw: GeminiDomReportPayload): BrowserReport {
  const headings: BrowserReportHeading[] = raw.headings
    .map((heading) => ({
      level: heading.level,
      text: normalizeWhitespace(heading.text),
    }))
    .filter((heading) => heading.text.length > 0);

  const tables: BrowserReportTable[] = raw.tables.map((table, index) => ({
    index: index + 1,
    caption: table.caption ? normalizeWhitespace(table.caption) : null,
    rows: table.rows
      .map((row) => row.map((cell) => normalizeWhitespace(cell)))
      .filter((row) => row.some((cell) => cell.length > 0)),
  }));

  const sources: BrowserReportSourceGroup[] = raw.sources
    .map((group) => ({
      title: normalizeWhitespace(group.title),
      links: dedupeGeminiLinks(
        group.links
          .map((link) => ({
            title: cleanGeminiSourceTitle(link.title, link.domain),
            url: link.url.trim(),
            domain: link.domain?.trim() || null,
          }))
          .filter((link) => link.title.length > 0 && link.url.length > 0),
      ),
    }))
    .filter((group) => group.title.length > 0 && group.links.length > 0);

  return {
    title: raw.title ? normalizeWhitespace(raw.title) : null,
    text: raw.text.trim(),
    html: raw.html,
    headings,
    tables,
    sources,
  };
}

export function composeGeminiReportMarkdown(
  report: BrowserReport,
  thoughts?: string | null,
): string {
  const body = report.text.trim();
  let markdown = body;

  if (thoughts?.trim()) {
    markdown = `## Thinking\n\n${thoughts.trim()}\n\n## Response\n\n${body}`;
  }

  if ((report.sources?.length ?? 0) > 0) {
    const sourcesMarkdown = report
      .sources!.map((group) => {
        const links = group.links
          .map((link) => `- [${escapeMarkdownText(link.title)}](${link.url})`)
          .join("\n");
        return `### ${group.title}\n\n${links}`;
      })
      .join("\n\n");
    markdown += `\n\n## Sources\n\n${sourcesMarkdown}`;
  }

  return markdown;
}

function splitGeminiResponse(raw: string): GeminiParsedResponse {
  const normalized = normalizeWhitespace(raw);
  const marker = "Gemini said";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    const body = normalized.replace(/^Show thinking/i, "").trim();
    return { body, thoughts: null };
  }

  const thoughts = normalized
    .slice(0, markerIndex)
    .replace(/^Show thinking/i, "")
    .trim();
  const body = normalized.slice(markerIndex + marker.length).trim();
  return {
    body,
    thoughts: thoughts.length > 0 ? thoughts : null,
  };
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

async function resolveUserDataBaseDir(): Promise<string> {
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return os.tmpdir();
}

async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
): Promise<LaunchedChrome | null> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) return null;

  const probe = await verifyDevToolsReachable({ port });
  if (!probe.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }

  const pid = await readChromePid(userDataDir);
  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

async function waitForDocumentReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await Runtime.evaluate({
      expression: "document.readyState",
      returnByValue: true,
    }).catch(() => null);
    const value = state?.result?.value as string | undefined;
    if (value === "complete" || value === "interactive") {
      return;
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for document readiness.");
}

async function navigateToGemini(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  url: string,
  logger: BrowserLogger,
): Promise<void> {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

async function dismissGeminiBanners(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const candidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter((el) => isVisible(el));
      const dismiss = candidates.find((el) => {
        const label = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        return label === 'not now' || label === 'got it' || label === 'close';
      });
      if (dismiss instanceof HTMLElement) {
        dismiss.click();
        return true;
      }
      return false;
    })()`,
    returnByValue: true,
  }).catch(() => undefined);
}

async function waitForGeminiComposerReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissGeminiBanners(Runtime).catch(() => undefined);
    const result = await Runtime.evaluate({
      expression: `(() => {
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return true;
        };
        const textbox = document.querySelector(${JSON.stringify(GEMINI_TEXTBOX_SELECTOR)});
        const tools = document.querySelector(${JSON.stringify(GEMINI_TOOLS_BUTTON_SELECTOR)});
        const href = location.href || '';
        return {
          composerReady: Boolean(textbox && isVisible(textbox)),
          toolsReady: Boolean(tools && isVisible(tools)),
          href,
        };
      })()`,
      returnByValue: true,
    }).catch(() => null);

    const value = result?.result?.value as
      | { composerReady?: boolean; toolsReady?: boolean; href?: string }
      | undefined;
    if (value?.composerReady && value.toolsReady) {
      logger("[gemini-web] Gemini composer ready");
      return;
    }
    if (typeof value?.href === "string" && /accounts\.google\.com/i.test(value.href)) {
      throw new BrowserAutomationError(
        "Gemini login required. Sign into gemini.google.com in the opened Chrome window, then retry.",
        {
          stage: "gemini-login",
          url: value.href,
        },
      );
    }
    await delay(250);
  }

  throw new BrowserAutomationError("Timed out waiting for Gemini composer.", {
    stage: "gemini-composer",
  });
}

async function ensureGeminiDeepResearchEnabled(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return true;
        };
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const buttonLabel = (el) => normalize(el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title'));
        const selectedChip = Array.from(document.querySelectorAll('button,[role="button"]')).find((el) => {
          return isVisible(el) && buttonLabel(el).includes('deselect deep research');
        });
        if (selectedChip) {
          return { status: 'selected' };
        }
        const toolItem = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((el) => {
          return isVisible(el) && buttonLabel(el).includes('deep research');
        });
        if (toolItem instanceof HTMLElement) {
          const checked = toolItem.getAttribute('aria-checked') === 'true' || toolItem.getAttribute('checked') != null;
          if (!checked) {
            toolItem.click();
            return { status: 'clicked-item' };
          }
          return { status: 'selected' };
        }
        const toolsButton = document.querySelector(${JSON.stringify(GEMINI_TOOLS_BUTTON_SELECTOR)});
        if (toolsButton instanceof HTMLElement && isVisible(toolsButton)) {
          toolsButton.click();
          return { status: 'opened-menu' };
        }
        return { status: 'waiting' };
      })()`,
      returnByValue: true,
    }).catch(() => null);

    const status = (result?.result?.value as { status?: string } | undefined)?.status;
    if (status === "selected") {
      logger("[gemini-web] Deep research enabled");
      return;
    }
    await delay(250);
  }

  throw new BrowserAutomationError("Timed out enabling Gemini Deep Research.", {
    stage: "gemini-deep-research-toggle",
  });
}

async function clearGeminiComposer(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(GEMINI_TEXTBOX_SELECTOR)});
      if (!(node instanceof HTMLElement)) return false;
      node.focus();
      node.textContent = '';
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
      return true;
    })()`,
    returnByValue: true,
  }).catch(() => undefined);
}

async function setGeminiComposerText(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  await clearGeminiComposer(Runtime);
  const focused = await Runtime.evaluate({
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(GEMINI_TEXTBOX_SELECTOR)});
      if (!(node instanceof HTMLElement)) return { focused: false };
      node.focus();
      const doc = node.ownerDocument;
      const selection = doc?.getSelection?.();
      if (selection && doc) {
        const range = doc.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return { focused: true };
    })()`,
    returnByValue: true,
  }).catch(() => null);

  if (!(focused?.result?.value as { focused?: boolean } | undefined)?.focused) {
    throw new Error("Failed to focus Gemini composer.");
  }

  const inserted = await Runtime.evaluate({
    expression: `document.execCommand('insertText', false, ${JSON.stringify(prompt)})`,
    returnByValue: true,
  }).catch(() => null);
  if (!inserted?.result?.value) {
    await Input.insertText({ text: prompt.replace(/\n/g, "\r") });
  }
  await delay(200);

  const verify = await Runtime.evaluate({
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(GEMINI_TEXTBOX_SELECTOR)});
      return node ? (node.innerText || node.textContent || '') : '';
    })()`,
    returnByValue: true,
  }).catch(() => null);
  const current = String(verify?.result?.value ?? "");
  if (!current.trim()) {
    logger("[gemini-web] composer empty after insertText; forcing textContent");
    await Runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(GEMINI_TEXTBOX_SELECTOR)});
        if (node) {
          node.textContent = ${JSON.stringify(prompt)};
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(prompt)}, inputType: 'insertFromPaste' }));
        }
      })()`,
    }).catch(() => undefined);
  }
}

async function submitGeminiPrompt(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  await setGeminiComposerText(Runtime, Input, prompt, logger);

  const clicked = await Runtime.evaluate({
    expression: `(() => {
      const button = document.querySelector(${JSON.stringify(GEMINI_SEND_BUTTON_SELECTOR)});
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
  }).catch(() => null);

  if (!clicked?.result?.value) {
    logger("[gemini-web] send button not found; falling back to Enter key");
    await Input.dispatchKeyEvent({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await Input.dispatchKeyEvent({ type: "char", text: "\r" });
    await Input.dispatchKeyEvent({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
}

async function readGeminiResearchState(
  Runtime: ChromeClient["Runtime"],
): Promise<GeminiResearchState> {
  const result = await Runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const buttonInfo = (root) =>
        Array.from(root.querySelectorAll('button,[role="button"]')).map((button) => ({
          text: normalize(button.textContent || ''),
          aria: button.getAttribute('aria-label'),
          disabled: button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true',
        }));
      const responses = Array.from(document.querySelectorAll('model-response')).map((node) => {
        const buttons = buttonInfo(node);
        const start = buttons.find((button) => /start research/i.test((button.text || '') + ' ' + (button.aria || '')));
        return {
          raw: normalize(node.textContent || ''),
          buttons,
          hasStartResearch: Boolean(start),
          startResearchDisabled: Boolean(start?.disabled),
        };
      });
      const stopResponseVisible = buttonInfo(document).some((button) => /stop response/i.test((button.text || '') + ' ' + (button.aria || '')));
      return {
        responses,
        bodyText: normalize(document.body.innerText || ''),
        stopResponseVisible,
      };
    })()`,
    returnByValue: true,
  });
  return result.result.value as GeminiResearchState;
}

async function readGeminiStructuredReport(
  Runtime: ChromeClient["Runtime"],
): Promise<BrowserReport | null> {
  const result = await Runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const report = document.querySelector('#extended-response-markdown-content');
      if (!(report instanceof HTMLElement)) return null;

      const parseHeadingLevel = (tagName) => {
        const match = /^H([1-6])$/i.exec(tagName || '');
        return match ? Number(match[1]) : 0;
      };

      const parseLink = (anchor) => {
        if (!(anchor instanceof HTMLAnchorElement)) return null;
        const domainNode = anchor.querySelector('[data-test-id="domain-name"]');
        const domain = normalize(domainNode?.textContent || anchor.hostname || '');
        const fullText = normalize(anchor.textContent || '');
        const title = fullText.replace(/\\bOpens in a new window\\b/gi, '').trim();
        return {
          title,
          url: anchor.href || '',
          domain: domain || null,
        };
      };

      const sourceRoot = report.closest('.response-container-content')?.querySelector('deep-research-source-lists');
      const sourceGroups = sourceRoot
        ? Array.from(sourceRoot.querySelectorAll('.source-list')).map((group) => {
            const heading = normalize(group.previousElementSibling?.textContent || '');
            const links = Array.from(group.querySelectorAll('a'))
              .map((anchor) => parseLink(anchor))
              .filter(Boolean);
            return { title: heading, links };
          })
        : [];

      const fallbackSourceGroups =
        sourceGroups.length > 0
          ? []
          : (() => {
              const container = report.closest('#extended-response-message-content');
              if (!(container instanceof HTMLElement)) return [];
              const groups = [];
              const labels = [
                'Sources used in the report',
                'Sources read but not used in the report',
                'Sources',
                'References',
              ];
              for (const label of labels) {
                const headingEl = Array.from(container.querySelectorAll('button,span,div,h2,h3,h4'))
                  .find((el) => normalize(el.textContent || '') === label);
                if (!(headingEl instanceof HTMLElement)) continue;
                const parent = headingEl.parentElement?.nextElementSibling;
                const links = Array.from((parent ?? container).querySelectorAll('a'))
                  .map((anchor) => parseLink(anchor))
                  .filter(Boolean);
                if (links.length > 0) groups.push({ title: label, links });
              }
              return groups;
            })();

      return {
        title: normalize(report.querySelector('h1')?.textContent || ''),
        text: report.innerText || '',
        html: report.innerHTML || '',
        headings: Array.from(report.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((heading) => ({
          level: parseHeadingLevel(heading.tagName),
          text: normalize(heading.textContent || ''),
        })),
        tables: Array.from(report.querySelectorAll('table')).map((table) => {
          const caption = normalize(
            table.querySelector('caption')?.textContent ||
              table.nextElementSibling?.textContent ||
              table.previousElementSibling?.textContent ||
              '',
          );
          return {
            caption: caption || null,
            rows: Array.from(table.querySelectorAll('tr')).map((row) =>
              Array.from(row.querySelectorAll('th,td')).map((cell) => normalize(cell.textContent || '')),
            ),
          };
        }),
        sources: sourceGroups.length > 0 ? sourceGroups : fallbackSourceGroups,
      };
    })()`,
    returnByValue: true,
  }).catch(() => null);

  const value = result?.result?.value as GeminiDomReportPayload | null | undefined;
  if (!value?.text?.trim()) return null;
  return normalizeGeminiReport(value);
}

async function waitForGeminiResearchPlan(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<GeminiResearchState> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const state = await readGeminiResearchState(Runtime);
    const plan = state.responses.find(
      (response) => response.hasStartResearch && !response.startResearchDisabled,
    );
    if (plan) {
      return state;
    }
    const latestRaw = state.responses.at(-1)?.raw ?? "";
    if (/something went wrong/i.test(latestRaw)) {
      lastError = latestRaw;
    }
    await delay(500);
  }

  throw new BrowserAutomationError(
    lastError
      ? `Gemini Deep Research failed before producing a plan: ${lastError}`
      : "Timed out waiting for Gemini Deep Research plan.",
    { stage: "gemini-deep-research-plan" },
  );
}

async function clickGeminiStartResearch(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const clicked = await Runtime.evaluate({
      expression: `(() => {
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        const start = buttons.find((button) => {
          const label = normalize(button.textContent || button.getAttribute('aria-label') || button.getAttribute('title'));
          const disabled = button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';
          return label.includes('start research') && !disabled;
        });
        if (!(start instanceof HTMLElement)) return { clicked: false };
        start.click();
        return { clicked: true };
      })()`,
      returnByValue: true,
    }).catch(() => null);
    if ((clicked?.result?.value as { clicked?: boolean } | undefined)?.clicked) {
      logger("[gemini-web] Approved Gemini Deep Research plan");
      return;
    }
    await delay(250);
  }

  throw new BrowserAutomationError("Timed out trying to start Gemini Deep Research.", {
    stage: "gemini-deep-research-start",
  });
}

async function waitForGeminiResearchReport(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<{ report: BrowserReport; thoughts: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastReport: BrowserReport | null = null;
  let lastThoughts: string | null = null;
  let stableForMs = 0;
  const interval = 1000;

  while (Date.now() < deadline) {
    const state = await readGeminiResearchState(Runtime);
    const latest = state.responses.at(-1);
    const parsed = splitGeminiResponse(latest?.raw ?? "");
    const candidate = parsed.body;
    const structuredReport = await readGeminiStructuredReport(Runtime);
    const reportText = structuredReport?.text.trim() || candidate;
    const candidateLooksFinal =
      reportText.length >= 400 &&
      !/as soon as your report is ready/i.test(reportText) &&
      !/researching \d+ websites/i.test(state.bodyText) &&
      !/ready in a few mins/i.test(state.bodyText);

    if (candidateLooksFinal) {
      if (lastReport && reportText === lastReport.text) {
        stableForMs += interval;
      } else {
        lastReport = structuredReport ?? {
          title: null,
          text: reportText,
          html: "",
          headings: [],
          tables: [],
          sources: [],
        };
        lastThoughts = parsed.thoughts;
        stableForMs = 0;
      }
      if (stableForMs >= 3000) {
        return { report: lastReport, thoughts: lastThoughts };
      }
    } else if (structuredReport?.text || candidate) {
      lastReport = structuredReport ?? {
        title: null,
        text: reportText,
        html: "",
        headings: [],
        tables: [],
        sources: [],
      };
      lastThoughts = parsed.thoughts;
      stableForMs = 0;
    }

    await delay(interval);
  }

  if ((lastReport?.text.length ?? 0) >= 400) {
    return { report: lastReport!, thoughts: lastThoughts };
  }

  throw new BrowserAutomationError("Timed out waiting for Gemini Deep Research report.", {
    stage: "gemini-deep-research-report",
  });
}

export async function runGeminiDeepResearchBrowser(
  runOptions: BrowserRunOptions,
  geminiOptions: GeminiWebOptions,
): Promise<BrowserRunResult> {
  const promptText = runOptions.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using Gemini Deep Research.");
  }
  if ((runOptions.attachments?.length ?? 0) > 0) {
    throw new BrowserAutomationError(
      "Gemini Deep Research does not support browser uploads yet. Retry without files.",
      {
        stage: "gemini-deep-research-attachments",
      },
    );
  }
  if (runOptions.fallbackSubmission?.attachments?.length) {
    throw new BrowserAutomationError(
      "Gemini Deep Research does not support fallback browser uploads yet. Retry without files.",
      {
        stage: "gemini-deep-research-attachments",
      },
    );
  }
  if (
    geminiOptions.youtube ||
    geminiOptions.generateImage ||
    geminiOptions.editImage ||
    geminiOptions.outputPath
  ) {
    throw new BrowserAutomationError(
      "Gemini Deep Research cannot be combined with --youtube, --generate-image, --edit-image, or --output.",
      { stage: "gemini-deep-research-options" },
    );
  }

  const logger: BrowserLogger = runOptions.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(runOptions.verbose);
  }
  const config = resolveBrowserConfig({
    ...(runOptions.config ?? {}),
    url: DEFAULT_GEMINI_URL,
    chatgptUrl: DEFAULT_GEMINI_URL,
    modelStrategy: "ignore",
  });
  const targetUrl = config.url;

  if (config.desiredModel) {
    logger(
      `[gemini-web] Gemini Deep Research uses the current Gemini web mode; desired model "${config.desiredModel}" is not auto-selected.`,
    );
  }

  let lastUrl: string | undefined;
  let lastTargetId: string | undefined;
  const runtimeHintCb = runOptions.runtimeHintCb;
  let chrome: (LaunchedChrome & { host?: string }) | null = null;
  let client: ChromeClient | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connectionClosedUnexpectedly = false;
  let runStatus: "attempted" | "complete" = "attempted";

  const emitRuntimeHint = async (host?: string, port?: number, targetId?: string) => {
    if (!runtimeHintCb || !port) return;
    try {
      await runtimeHintCb({
        chromePid: chrome?.pid,
        chromePort: port,
        chromeHost: host,
        chromeTargetId: targetId ?? lastTargetId,
        tabUrl: lastUrl,
        controllerPid: process.pid,
        userDataDir: remoteChromeConfig ? undefined : userDataDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };

  const startedAt = Date.now();
  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : DEFAULT_ORACLE_BROWSER_PROFILE_DIR;
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-gemini-deep-"));

  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const remoteChromeConfig = config.remoteChrome;
  const chromeHost = remoteChromeConfig?.host ?? "127.0.0.1";

  try {
    if (remoteChromeConfig) {
      logger(
        `Connecting to remote Chrome at ${remoteChromeConfig.host}:${remoteChromeConfig.port}`,
      );
      const connection = await connectToRemoteChrome(
        remoteChromeConfig.host,
        remoteChromeConfig.port,
        logger,
        targetUrl,
      );
      client = connection.client;
      lastTargetId = connection.targetId ?? undefined;
      client.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
      });
      await emitRuntimeHint(remoteChromeConfig.host, remoteChromeConfig.port, lastTargetId);
    } else {
      const reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
      chrome =
        reusedChrome ?? (await launchChrome({ ...config, url: targetUrl }, userDataDir, logger));

      const host = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
      if (config.hideWindow) {
        await hideChromeWindow(chrome, logger);
      }
      if (manualLogin && chrome.port) {
        await writeDevToolsActivePort(userDataDir, chrome.port);
        if (!reusedChrome && chrome.pid) {
          await writeChromePid(userDataDir, chrome.pid);
        }
      }
      removeTerminationHooks = registerTerminationHooks(
        chrome,
        userDataDir,
        effectiveKeepBrowser,
        logger,
        {
          isInFlight: () => runStatus !== "complete",
          emitRuntimeHint: async () => emitRuntimeHint(host, chrome?.port, lastTargetId),
          preserveUserDataDir: manualLogin,
        },
      );

      const connection = await connectWithNewTab(chrome.port, logger, undefined, host);
      client = connection.client;
      lastTargetId = connection.targetId ?? undefined;
    }

    if (!client) {
      throw new Error("Failed to connect to Chrome for Gemini Deep Research session.");
    }

    const { Network, Page, Runtime, Input, DOM } = client;
    const enablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      enablers.push(DOM.enable());
    }
    await Promise.all(enablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);

    if (!remoteChromeConfig && !manualLogin) {
      await Network.clearBrowserCookies();
    }

    if (!remoteChromeConfig) {
      const cookieSyncEnabled = config.cookieSync && (!manualLogin || config.manualLoginCookieSync);
      if (cookieSyncEnabled) {
        const applied = await syncCookies(Network, targetUrl, config.chromeProfile, logger, {
          allowErrors: config.allowCookieErrors ?? false,
          filterNames: config.cookieNames ?? undefined,
          inlineCookies: config.inlineCookies ?? undefined,
          cookiePath: config.chromeCookiePath ?? undefined,
          waitMs: config.cookieSyncWaitMs ?? 0,
          origins: [
            "https://gemini.google.com",
            "https://accounts.google.com",
            "https://www.google.com",
          ],
        });
        if (config.inlineCookies && applied === 0) {
          throw new Error("No inline cookies were applied; aborting before navigation.");
        }
        logger(
          applied > 0
            ? `Applied ${applied} cookies`
            : "No cookies applied; continuing without session reuse",
        );
      } else if (manualLogin) {
        logger(
          "Skipping cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in.",
        );
      } else {
        logger("Skipping cookie sync (--browser-no-cookie-sync)");
      }
    } else {
      logger("Skipping cookie sync for remote Chrome (using existing session)");
    }

    await navigateToGemini(Page, Runtime, targetUrl, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await waitForGeminiComposerReady(Runtime, config.inputTimeoutMs ?? 60_000, logger);
    await ensureGeminiDeepResearchEnabled(Runtime, logger);

    const readLocation = async () => {
      const value = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      }).catch(() => null);
      const href = typeof value?.result?.value === "string" ? value.result.value : undefined;
      if (href) lastUrl = href;
    };
    await readLocation();
    await emitRuntimeHint(chromeHost, remoteChromeConfig?.port ?? chrome?.port, lastTargetId);

    await submitGeminiPrompt(Runtime, Input, promptText, logger);
    await waitForGeminiResearchPlan(Runtime, Math.min(config.timeoutMs ?? 180_000, 180_000));
    await clickGeminiStartResearch(Runtime, logger);
    await readLocation();

    const researchTimeoutMs = Math.max(config.timeoutMs ?? 1_800_000, 300_000);
    const answer = await waitForGeminiResearchReport(
      Runtime,
      Math.min(researchTimeoutMs, 3_600_000),
    );

    runStatus = "complete";
    const answerText = answer.report.text.trim();
    const answerTokens = estimateTokenCount(answerText);
    const answerMarkdown = composeGeminiReportMarkdown(
      answer.report,
      geminiOptions.showThoughts ? answer.thoughts : null,
    );
    const tookMs = Date.now() - startedAt;

    return {
      answerText,
      answerMarkdown,
      answerHtml: answer.report.html,
      tookMs,
      answerTokens,
      answerChars: answerText.length,
      chromePid: chrome?.pid,
      chromePort: remoteChromeConfig?.port ?? chrome?.port,
      chromeHost: remoteChromeConfig?.host ?? chromeHost,
      userDataDir: remoteChromeConfig ? undefined : userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      controllerPid: process.pid,
      response: {
        tabUrl: lastUrl,
        report: answer.report,
      },
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (!connectionClosedUnexpectedly) {
      logger(`Failed to complete Gemini Deep Research run: ${normalizedError.message}`);
    }
    if (connectionClosedUnexpectedly) {
      await emitRuntimeHint(chromeHost, remoteChromeConfig?.port ?? chrome?.port, lastTargetId);
      throw new BrowserAutomationError(
        "Chrome window closed before oracle finished. Please keep it open until completion.",
        {
          stage: "connection-lost",
          runtime: {
            chromePid: chrome?.pid,
            chromePort: remoteChromeConfig?.port ?? chrome?.port,
            chromeHost: remoteChromeConfig?.host ?? chromeHost,
            userDataDir: remoteChromeConfig ? undefined : userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: lastUrl,
            controllerPid: process.pid,
          },
        },
        normalizedError,
      );
    }
    throw normalizedError;
  } finally {
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }

    if (!remoteChromeConfig && chrome?.port && lastTargetId && !effectiveKeepBrowser) {
      await closeTab(chrome.port, lastTargetId, logger, chromeHost).catch(() => undefined);
    } else if (remoteChromeConfig && lastTargetId) {
      await closeRemoteChromeTarget(
        remoteChromeConfig.host,
        remoteChromeConfig.port,
        lastTargetId,
        logger,
      ).catch(() => undefined);
    }

    removeDialogHandler?.();
    removeTerminationHooks?.();

    if (!remoteChromeConfig && chrome && !effectiveKeepBrowser) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
        } catch {
          // ignore
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          {
            connectionClosedUnexpectedly,
            host: chromeHost,
          },
        );
        if (shouldCleanup) {
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
