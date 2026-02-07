import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger, BrowserAttachment, ChromeClient } from '../browser/types.js';
import { BrowserAutomationError } from '../oracle/errors.js';
import { resolveBrowserConfig } from '../browser/config.js';
import { DEFAULT_ORACLE_BROWSER_PROFILE_DIR } from '../browser/profileDefaults.js';
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectWithNewTab,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
  closeTab,
} from '../browser/chromeLifecycle.js';
import { syncCookies } from '../browser/cookies.js';
import { delay, estimateTokenCount } from '../browser/utils.js';
import { installJavaScriptDialogAutoDismissal, ensureNotBlocked } from '../browser/actions/navigation.js';
import { uploadAttachmentFile, waitForAttachmentCompletion, clearComposerAttachments } from '../browser/actions/attachments.js';
import { uploadAttachmentViaDataTransfer } from '../browser/actions/remoteFileTransfer.js';
import {
  cleanupStaleProfileState,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from '../browser/profileState.js';
import type { LaunchedChrome } from 'chrome-launcher';

export interface GrokWebOptions {
  baseUrl?: string | null;
}

const DEFAULT_GROK_URL = 'https://grok.com/';
const GROK_COMPOSER_SELECTOR = 'div.tiptap.ProseMirror[contenteditable="true"]';
const GROK_SUBMIT_SELECTOR = 'form button[type="submit"][aria-label="Submit"]';
const GROK_RESPONSE_SELECTOR = 'div[id^="response-"]';
const GROK_PROFILE_BUTTON = 'button[aria-label="pfp"]';
const GROK_MODEL_TRIGGER_SELECTOR = 'button#model-select-trigger, button[aria-label="Model select"]';

const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'atlas.openai.com'];

function resolveGrokUrl(options: GrokWebOptions): string {
  const fromOptions = options.baseUrl?.trim();
  if (fromOptions) return fromOptions;
  const fromEnv = process.env.ORACLE_GROK_URL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_GROK_URL;
}

function resolveGrokTargetUrl(
  candidate: string | null | undefined,
  fallback: string,
): string {
  const trimmed = candidate?.trim();
  if (!trimmed) return fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase();
    if (CHATGPT_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes('microsoft');
}

async function resolveUserDataBaseDir(): Promise<string> {
  if (isWsl()) {
    const candidates = [
      '/mnt/c/Users/Public/AppData/Local/Temp',
      '/mnt/c/Temp',
      '/mnt/c/Windows/Temp',
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

async function maybeReuseRunningChrome(userDataDir: string, logger: BrowserLogger): Promise<LaunchedChrome | null> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) return null;

  const probe = await verifyDevToolsReachable({ port });
  if (!probe.ok) {
    logger(`DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`);
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'if_oracle_pid_dead' });
    return null;
  }

  const pid = await readChromePid(userDataDir);
  logger(`Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ''})`);
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await Runtime.evaluate({
      expression: 'document.readyState',
      returnByValue: true,
    }).catch(() => null);
    const value = state?.result?.value as string | undefined;
    if (value === 'complete' || value === 'interactive') {
      return;
    }
    await delay(200);
  }
  throw new Error('Timed out waiting for document readiness.');
}

async function navigateToGrok(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
): Promise<void> {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

async function ensureGrokLoggedIn(Runtime: ChromeClient['Runtime'], logger: BrowserLogger): Promise<void> {
  const probe = await Runtime.evaluate({
    expression: `(() => {
      const href = location.href || '';
      const signInLink = Array.from(document.querySelectorAll('a')).some((a) => {
        const text = (a.textContent || '').toLowerCase();
        const url = (a.getAttribute('href') || '').toLowerCase();
        return (text.includes('sign in') || text.includes('log in')) && url.includes('sign-in');
      });
      const loginButton = Array.from(document.querySelectorAll('button')).some((b) => {
        const text = (b.textContent || '').toLowerCase();
        return text.includes('login with');
      });
      const profileButton = document.querySelector(${JSON.stringify(GROK_PROFILE_BUTTON)});
      const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
      return {
        href,
        signInLink,
        loginButton,
        hasProfile: Boolean(profileButton),
        hasComposer: Boolean(composer),
      };
    })()`,
    returnByValue: true,
  });

  const value = probe?.result?.value as {
    href?: string;
    signInLink?: boolean;
    loginButton?: boolean;
    hasProfile?: boolean;
    hasComposer?: boolean;
  } | null;

  const href = value?.href ?? '';
  const onLoginPage = /accounts\.x\.ai|x\.com\/i\/flow\/login|sign-in|oauth2/i.test(href);
  const loggedOut = onLoginPage || ((value?.signInLink || value?.loginButton) && !value?.hasProfile);

  if (loggedOut) {
    logger('Grok login not detected; browser session appears logged out.');
    throw new BrowserAutomationError(
      'Grok login required. Sign into grok.com (or accounts.x.ai) in the opened Chrome window, then retry.',
      {
        stage: 'grok-login',
        url: href || undefined,
      },
    );
  }

  if (!value?.hasComposer) {
    logger('Grok composer not yet available after login check; waiting for composer readiness.');
  }
}

async function waitForComposerReady(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
        const submit = document.querySelector(${JSON.stringify(GROK_SUBMIT_SELECTOR)});
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return true;
        };
        return {
          composerReady: Boolean(composer && isVisible(composer)),
          submitReady: Boolean(submit && isVisible(submit)),
        };
      })()`,
      returnByValue: true,
    }).catch(() => null);

    const value = result?.result?.value as { composerReady?: boolean; submitReady?: boolean } | undefined;
    if (value?.composerReady) {
      if (!value.submitReady) {
        // Submit button sometimes appears after composer; allow short extra wait.
        await delay(200);
      }
      logger('Grok composer ready');
      return;
    }
    await delay(250);
  }

  throw new BrowserAutomationError('Timed out waiting for Grok composer.', {
    stage: 'grok-composer',
  });
}

function normalizeModelLabel(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function resolveGrokModelLabel(input: string): string {
  const normalized = normalizeModelLabel(input);
  if (!normalized) return '';
  if (normalized === 'grok-4.1' || normalized === 'grok 4.1' || normalized === '4.1') {
    return 'fast';
  }
  if (normalized === 'grok-4.1-thinking' || normalized === 'grok 4.1 thinking' || normalized === 'thinking') {
    return 'grok 4.1 thinking';
  }
  return normalized;
}

async function selectGrokModel(
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'],
  desiredModel: string | null | undefined,
  logger: BrowserLogger,
): Promise<void> {
  const desiredRaw = desiredModel?.trim() ?? '';
  if (!desiredRaw) return;
  const desired = resolveGrokModelLabel(desiredRaw);

  // Grok may ignore synthetic `.click()` (isTrusted checks). Prefer a CDP mouse click.
  const opened = await (async () => {
    const locate = await Runtime.evaluate({
      expression: `(() => {
        const trigger = document.querySelector(${JSON.stringify(GROK_MODEL_TRIGGER_SELECTOR)});
        if (!(trigger instanceof HTMLElement)) return { ok: false };
        trigger.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = trigger.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: false };
        return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    }).catch(() => null);
    const value = locate?.result?.value as { ok?: boolean; x?: number; y?: number } | undefined;
    if (value?.ok && typeof value.x === 'number' && typeof value.y === 'number') {
      const x = value.x;
      const y = value.y;
      try {
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
        await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return true;
      } catch {
        // fall through to synthetic click
      }
    }
    const clicked = await Runtime.evaluate({
      expression: `(() => {
        const trigger = document.querySelector(${JSON.stringify(GROK_MODEL_TRIGGER_SELECTOR)});
        if (!(trigger instanceof HTMLElement)) return false;
        trigger.click();
        return true;
      })()`,
      returnByValue: true,
    }).catch(() => null);
    return Boolean(clicked?.result?.value);
  })();

  if (!opened) {
    logger(`[grok-web] Model picker not found; unable to select "${desiredRaw}".`);
    return;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const selection = await Runtime.evaluate({
      expression: `(() => {
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const desired = ${JSON.stringify(desired)};
        const items = Array.from(document.querySelectorAll('[role=\"menuitem\"],[role=\"menuitemradio\"]'));
        const labels = items.map((item) => normalize(item.textContent || ''));
        // Prefer exact/prefix matches so "expert" doesn't match "auto ... expert".
        let matchIndex = labels.findIndex((label) => label && label === desired);
        if (matchIndex === -1) {
          matchIndex = labels.findIndex((label) => label && label.startsWith(desired));
        }
        if (matchIndex === -1) {
          matchIndex = labels.findIndex((label) => label && (label.includes(desired) || desired.includes(label)));
        }
        if (matchIndex === -1 && desired.includes('grok 4.1 thinking')) {
          matchIndex = labels.findIndex((label) => label.includes('thinking'));
        }
        if (matchIndex === -1) {
          return { matched: false, labels };
        }
        const target = items[matchIndex];
        if (!(target instanceof HTMLElement)) {
          return { matched: false, labels };
        }
        const rect = target.getBoundingClientRect();
        return { matched: true, label: labels[matchIndex], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    }).catch(() => null);

    const value = selection?.result?.value as
      | { matched?: boolean; label?: string; labels?: string[]; x?: number; y?: number }
      | undefined;
    if (value?.matched) {
      if (typeof value.x === 'number' && typeof value.y === 'number') {
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: value.x, y: value.y }).catch(() => undefined);
        await Input
          .dispatchMouseEvent({ type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 })
          .catch(() => undefined);
        await Input
          .dispatchMouseEvent({ type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 })
          .catch(() => undefined);
      }
      logger(`[grok-web] Selected Grok model: ${value.label ?? desired}`);
      return;
    }
    if (value?.labels && value.labels.length > 0) {
      logger(`[grok-web] Grok model "${desiredRaw}" not found. Available: ${value.labels.join(', ')}`);
      break;
    }
    await delay(200);
  }

  await Runtime.evaluate({
    expression: 'document.body.click()',
  }).catch(() => undefined);
}

async function clearComposerText(Runtime: ChromeClient['Runtime']): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
      if (!node) return false;
      node.textContent = '';
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
      return true;
    })()`,
  }).catch(() => undefined);
}

async function setComposerText(
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'],
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  const focused = await Runtime.evaluate({
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
      if (!node) return { focused: false };
      node.focus();
      const doc = node.ownerDocument;
      const selection = doc?.getSelection?.();
      if (selection) {
        const range = doc.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return { focused: true };
    })()`,
    returnByValue: true,
  });
  if (!focused?.result?.value?.focused) {
    throw new Error('Failed to focus Grok composer.');
  }

  await Input.insertText({ text: prompt });
  await delay(200);

  const verify = await Runtime.evaluate({
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
      return node ? (node.innerText || node.textContent || '') : '';
    })()`,
    returnByValue: true,
  });
  const current = String(verify?.result?.value ?? '');
  if (!current.trim()) {
    logger('[grok-web] composer empty after insertText; forcing textContent');
    await Runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
        if (node) {
          node.textContent = ${JSON.stringify(prompt)};
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(prompt)}, inputType: 'insertFromPaste' }));
        }
      })()`,
    });
  }

  const promptLength = prompt.length;
  if (promptLength >= 50_000) {
    const observedLength = current.trim().length;
    if (observedLength > 0 && observedLength < promptLength - 2_000) {
      throw new BrowserAutomationError('Prompt appears truncated in the Grok composer.', {
        stage: 'grok-submit',
        code: 'prompt-too-large',
        promptLength,
        observedLength,
      });
    }
  }
}

async function submitPrompt(
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'],
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  await clearComposerText(Runtime);
  await setComposerText(Runtime, Input, prompt, logger);

  const clicked = await Runtime.evaluate({
    expression: `(() => {
      const btn = document.querySelector(${JSON.stringify(GROK_SUBMIT_SELECTOR)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
    returnByValue: true,
  });

  if (!clicked?.result?.value) {
    logger('[grok-web] submit button not found; falling back to Enter key');
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await Input.dispatchKeyEvent({ type: 'char', text: '\r' });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  // Wait for composer to clear (best-effort)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await Runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
        return node ? (node.innerText || node.textContent || '').trim() : '';
      })()`,
      returnByValue: true,
    });
    const text = String(value?.result?.value ?? '');
    if (!text) return;
    await delay(200);
  }
}

async function uploadAttachments(
  deps: { Runtime: ChromeClient['Runtime']; Input: ChromeClient['Input']; DOM?: ChromeClient['DOM'] },
  attachments: BrowserAttachment[],
  logger: BrowserLogger,
  remote: boolean,
  inputTimeoutMs: number,
): Promise<void> {
  if (attachments.length === 0) return;
  if (!deps.DOM) {
    throw new Error('Chrome DOM domain unavailable while uploading attachments.');
  }

  await clearComposerAttachments(deps.Runtime, 5_000, logger);

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    logger(`Uploading attachment: ${attachment.displayPath}`);
    if (remote) {
      await uploadAttachmentViaDataTransfer({ runtime: deps.Runtime, dom: deps.DOM }, attachment, logger);
    } else {
      await uploadAttachmentFile({ runtime: deps.Runtime, dom: deps.DOM, input: deps.Input }, attachment, logger, {
        expectedCount: index + 1,
      });
    }
    await delay(300);
  }

  const attachmentNames = attachments.map((a) => path.basename(a.path));
  const baseTimeout = inputTimeoutMs || 30_000;
  const waitBudget = Math.max(baseTimeout, 45_000) + (attachments.length - 1) * 20_000;
  try {
    await waitForAttachmentCompletion(deps.Runtime, waitBudget, attachmentNames, logger);
    logger('All attachments uploaded');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Attachments did not finish uploading before timeout/i.test(message)) {
      logger(`[grok-web] Attachment upload timed out after ${Math.round(waitBudget / 1000)}s; continuing.`);
      return;
    }
    throw error;
  }
}

async function getAssistantSnapshot(Runtime: ChromeClient['Runtime']) {
  const result = await Runtime.evaluate({
    expression: `(() => {
      const responses = Array.from(document.querySelectorAll(${JSON.stringify(GROK_RESPONSE_SELECTOR)}));
      const assistant = responses.filter((el) => (el.className || '').includes('items-start'));
      const last = assistant[assistant.length - 1];
      const content = last ? (last.querySelector('.response-content-markdown') || last.querySelector('.message-bubble')) : null;
      const text = content ? (content.innerText || content.textContent || '') : '';
      const html = content ? content.innerHTML || '' : '';
      const regenerate = last ? last.querySelector('button[aria-label="Regenerate"]') : null;
      return {
        id: last?.id || null,
        text,
        html,
        hasRegenerate: Boolean(regenerate),
      };
    })()`,
    returnByValue: true,
  });
  return result?.result?.value as { id: string | null; text: string; html: string; hasRegenerate: boolean } | undefined;
}

async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  timeoutMs: number,
  baseline?: { id: string | null; text: string },
): Promise<{ text: string; html: string }> {
  const deadline = Date.now() + timeoutMs;
  const baseId = baseline?.id ?? null;
  const baseText = baseline?.text ?? '';
  let lastText = '';
  let stableForMs = 0;
  const interval = 500;

  while (Date.now() < deadline) {
    const snapshot = await getAssistantSnapshot(Runtime);
    const text = snapshot?.text?.trim?.() ?? '';
    const id = snapshot?.id ?? null;
    const isNew = text && (id !== baseId || text !== baseText);
    if (isNew) {
      if (text === lastText) {
        stableForMs += interval;
      } else {
        stableForMs = 0;
        lastText = text;
      }
      const done = stableForMs >= 2000 && (snapshot?.hasRegenerate || stableForMs >= 4000);
      if (done) {
        return { text, html: snapshot?.html ?? '' };
      }
    }
    await delay(interval);
  }

  logger('[grok-web] Timed out waiting for assistant response');
  throw new BrowserAutomationError('Timed out waiting for Grok response.', { stage: 'grok-response' });
}

export function createGrokWebExecutor(
  grokOptions: GrokWebOptions = {},
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunResult> => {
    const promptText = runOptions.prompt?.trim();
    if (!promptText) {
      throw new Error('Prompt text is required when using Grok browser mode.');
    }

    const attachments: BrowserAttachment[] = runOptions.attachments ?? [];
    const logger: BrowserLogger = runOptions.log ?? ((_message: string) => {});
    if (logger.verbose === undefined) {
      logger.verbose = Boolean(runOptions.verbose);
    }
    const fallbackUrl = resolveGrokUrl(grokOptions);
    const candidateUrl = runOptions.config?.url ?? runOptions.config?.chatgptUrl;
    const url = resolveGrokTargetUrl(candidateUrl, fallbackUrl);
    const config = resolveBrowserConfig({
      ...(runOptions.config ?? {}),
      url,
      chatgptUrl: url,
      modelStrategy: 'ignore',
    });
    const targetUrl = config.url;

    let lastUrl: string | undefined;
    let lastTargetId: string | undefined;
    const runtimeHintCb = runOptions.runtimeHintCb;
    let chrome: (LaunchedChrome & { host?: string }) | null = null;
    let client: ChromeClient | null = null;
    let removeTerminationHooks: (() => void) | null = null;
    let removeDialogHandler: (() => void) | null = null;
    let connectionClosedUnexpectedly = false;
    let runStatus: 'attempted' | 'complete' = 'attempted';

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
      : await mkdtemp(path.join(await resolveUserDataBaseDir(), 'oracle-grok-'));

    if (manualLogin) {
      await mkdir(userDataDir, { recursive: true });
      logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    } else {
      logger(`Created temporary Chrome profile at ${userDataDir}`);
    }

    const effectiveKeepBrowser = Boolean(config.keepBrowser);
    const remoteChromeConfig = config.remoteChrome;
    const chromeHost = remoteChromeConfig?.host ?? '127.0.0.1';

    try {
      if (remoteChromeConfig) {
        logger(`Connecting to remote Chrome at ${remoteChromeConfig.host}:${remoteChromeConfig.port}`);
        const connection = await connectToRemoteChrome(
          remoteChromeConfig.host,
          remoteChromeConfig.port,
          logger,
          targetUrl,
        );
        client = connection.client;
        lastTargetId = connection.targetId ?? undefined;
        client.on('disconnect', () => {
          connectionClosedUnexpectedly = true;
        });
        await emitRuntimeHint(remoteChromeConfig.host, remoteChromeConfig.port, lastTargetId);
      } else {
        const reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
        chrome =
          reusedChrome ??
          (await launchChrome({ ...config, url: targetUrl }, userDataDir, logger));

        const host = (chrome as unknown as { host?: string }).host ?? '127.0.0.1';
        if (config.hideWindow) {
          await hideChromeWindow(chrome, logger);
        }
        if (manualLogin && chrome.port) {
          await writeDevToolsActivePort(userDataDir, chrome.port);
          if (!reusedChrome && chrome.pid) {
            await writeChromePid(userDataDir, chrome.pid);
          }
        }
        removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, effectiveKeepBrowser, logger, {
          isInFlight: () => runStatus !== 'complete',
          emitRuntimeHint: async () => emitRuntimeHint(host, chrome?.port, lastTargetId),
          preserveUserDataDir: manualLogin,
        });

        const connection = await connectWithNewTab(chrome.port, logger, undefined, host);
        client = connection.client;
        lastTargetId = connection.targetId ?? undefined;
      }

      if (!client) {
        throw new Error('Failed to connect to Chrome for Grok browser session.');
      }

      const { Network, Page, Runtime, Input, DOM } = client;
      const enablers = [Network.enable({}), Page.enable(), Runtime.enable()];
      if (DOM && typeof DOM.enable === 'function') {
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
            origins: ['https://grok.com', 'https://x.com', 'https://twitter.com', 'https://accounts.x.ai'],
          });
          if (config.inlineCookies && applied === 0) {
            throw new Error('No inline cookies were applied; aborting before navigation.');
          }
          logger(applied > 0 ? `Applied ${applied} cookies` : 'No cookies applied; continuing without session reuse');
        } else if (manualLogin) {
          logger('Skipping cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in.');
        } else {
          logger('Skipping cookie sync (--browser-no-cookie-sync)');
        }
      } else {
        logger('Skipping cookie sync for remote Chrome (using existing session)');
      }

      await navigateToGrok(Page, Runtime, targetUrl, logger);
      await ensureNotBlocked(Runtime, config.headless, logger);
      await ensureGrokLoggedIn(Runtime, logger);
      await waitForComposerReady(Runtime, config.inputTimeoutMs ?? 60_000, logger);
      await selectGrokModel(Runtime, Input, config.desiredModel ?? undefined, logger);

      const readLocation = async () => {
        const value = await Runtime.evaluate({ expression: 'location.href', returnByValue: true }).catch(() => null);
        const href = typeof value?.result?.value === 'string' ? value.result.value : undefined;
        if (href) lastUrl = href;
      };
      await readLocation();
      await emitRuntimeHint(chromeHost, remoteChromeConfig?.port ?? chrome?.port, lastTargetId);

      const baseline = await getAssistantSnapshot(Runtime).catch(() => undefined);

      const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
        if (submissionAttachments.length > 0) {
          await uploadAttachments(
            { Runtime, Input, DOM },
            submissionAttachments,
            logger,
            Boolean(remoteChromeConfig),
            config.inputTimeoutMs ?? 30_000,
          );
        }
        await submitPrompt(Runtime, Input, prompt, logger);
      };

      try {
        await submitOnce(promptText, attachments);
      } catch (error) {
        const isPromptTooLarge =
          error instanceof BrowserAutomationError &&
          (error.details as { code?: string } | undefined)?.code === 'prompt-too-large';
        if (runOptions.fallbackSubmission && isPromptTooLarge) {
          logger('[grok-web] Inline prompt too large; retrying with file uploads.');
          await submitOnce(runOptions.fallbackSubmission.prompt, runOptions.fallbackSubmission.attachments);
        } else {
          throw error;
        }
      }
      await readLocation();

      const answer = await waitForAssistantResponse(
        Runtime,
        logger,
        config.timeoutMs ?? 1_200_000,
        baseline ? { id: baseline.id, text: baseline.text } : undefined,
      );

      runStatus = 'complete';
      const answerText = answer.text.trim();
      const answerTokens = estimateTokenCount(answerText);
      const answerMarkdown = answerText;
      const answerHtml = answer.html;
      const tookMs = Date.now() - startedAt;

      return {
        answerText,
        answerMarkdown,
        answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
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
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (!connectionClosedUnexpectedly) {
        logger(`Failed to complete Grok run: ${normalizedError.message}`);
      }
      if (connectionClosedUnexpectedly) {
        await emitRuntimeHint(chromeHost, remoteChromeConfig?.port ?? chrome?.port, lastTargetId);
        throw new BrowserAutomationError(
          'Chrome window closed before oracle finished. Please keep it open until completion.',
          {
            stage: 'connection-lost',
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
        await closeRemoteChromeTarget(remoteChromeConfig.host, remoteChromeConfig.port, lastTargetId, logger).catch(
          () => undefined,
        );
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
          const shouldCleanup = await shouldCleanupManualLoginProfileState(userDataDir, logger.verbose ? logger : undefined, {
            connectionClosedUnexpectedly,
            host: chromeHost,
          });
          if (shouldCleanup) {
            await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'never' }).catch(() => undefined);
          }
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  };
}
