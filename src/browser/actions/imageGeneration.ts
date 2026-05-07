import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ImageAspectRatio } from "../../oracle/types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  INPUT_SELECTORS,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

interface GeneratedImageAsset {
  src: string;
  mimeType: string;
  base64: string;
  width: number;
  height: number;
  alt?: string;
}

interface ImageSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
  images: Array<{
    src: string;
    width: number;
    height: number;
    alt?: string;
  }>;
}

export interface ChatGptImageCaptureResult {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
  outputPaths: string[];
}

export async function ensureChatGptImageMode(
  Runtime: ChromeClient["Runtime"],
  aspectRatio: ImageAspectRatio | undefined,
  logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: buildEnsureImageModeExpression(aspectRatio),
      returnByValue: true,
      awaitPromise: true,
    });
    const value = result?.value as { status?: string; detail?: string } | undefined;
    lastStatus = value?.status ?? "";
    if (lastStatus === "ready") {
      logger(
        aspectRatio ? `ChatGPT image mode ready (${aspectRatio})` : "ChatGPT image mode ready",
      );
      return;
    }
    if (lastStatus === "button-missing" || lastStatus === "aspect-missing") {
      break;
    }
    await delay(200);
  }

  await logDomFailure(Runtime, logger, "image-mode");
  throw new BrowserAutomationError("Unable to enable ChatGPT image mode.", {
    stage: "image-mode",
    details: { status: lastStatus || "timeout", aspectRatio: aspectRatio ?? null },
  });
}

export async function waitForChatGptGeneratedImages(
  Runtime: ChromeClient["Runtime"],
  outputPath: string,
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<ChatGptImageCaptureResult> {
  const snapshot = await waitForStableImageSnapshot(Runtime, timeoutMs, minTurnIndex);
  if (!snapshot) {
    await logDomFailure(Runtime, logger, "image-capture");
    throw new BrowserAutomationError("ChatGPT finished without detectable generated images.", {
      stage: "image-capture",
      details: { outputPath },
    });
  }

  const assets = await fetchGeneratedImages(Runtime, snapshot.images);
  if (assets.length === 0) {
    await logDomFailure(Runtime, logger, "image-download");
    throw new BrowserAutomationError("Unable to download generated image assets.", {
      stage: "image-download",
      details: { outputPath, imageCount: snapshot.images.length },
    });
  }

  const outputPaths = await saveGeneratedImages(assets, outputPath);
  logger(
    `Saved ${outputPaths.length} generated image${outputPaths.length === 1 ? "" : "s"}: ${outputPaths.join(", ")}`,
  );

  return {
    text: (snapshot.text ?? "").trim(),
    html: snapshot.html,
    meta: {
      messageId: snapshot.messageId ?? undefined,
      turnId: snapshot.turnId ?? undefined,
    },
    outputPaths,
  };
}

export function buildEnsureImageModeExpressionForTest(aspectRatio?: ImageAspectRatio): string {
  return buildEnsureImageModeExpression(aspectRatio);
}

export function buildImageSnapshotExpressionForTest(minTurnIndex?: number): string {
  return buildImageSnapshotExpression(minTurnIndex);
}

async function waitForStableImageSnapshot(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
): Promise<ImageSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  let best: ImageSnapshot | null = null;
  let stableCycles = 0;
  let lastSignature = "";

  while (Date.now() < deadline) {
    const snapshot = await readImageSnapshot(Runtime, minTurnIndex);
    if (snapshot && snapshot.images.length > 0) {
      const signature = snapshot.images.map((image) => image.src).join("\n");
      if (signature !== lastSignature) {
        best = snapshot;
        lastSignature = signature;
        stableCycles = 0;
      } else {
        stableCycles += 1;
      }
      const stopVisible = await isStopButtonVisible(Runtime);
      const finished = await isImageTurnFinished(Runtime, minTurnIndex);
      if (!stopVisible && (finished || stableCycles >= 6)) {
        return snapshot;
      }
    } else {
      stableCycles = 0;
    }
    await delay(500);
  }

  return best;
}

async function readImageSnapshot(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<ImageSnapshot | null> {
  const { result } = await Runtime.evaluate({
    expression: buildImageSnapshotExpression(minTurnIndex),
    returnByValue: true,
  });
  const value = result?.value as ImageSnapshot | null | undefined;
  return value && Array.isArray(value.images) ? value : null;
}

async function fetchGeneratedImages(
  Runtime: ChromeClient["Runtime"],
  images: ImageSnapshot["images"],
): Promise<GeneratedImageAsset[]> {
  const { result } = await Runtime.evaluate({
    expression: buildFetchImagesExpression(images.map((image) => image.src)),
    returnByValue: true,
    awaitPromise: true,
  });
  const value = result?.value as { images?: GeneratedImageAsset[] } | undefined;
  return value?.images ?? [];
}

async function saveGeneratedImages(
  assets: GeneratedImageAsset[],
  outputPath: string,
): Promise<string[]> {
  const target = await resolveImageTargets(outputPath, assets);
  await mkdir(target.directory, { recursive: true });
  const outputPaths: string[] = [];

  for (const [index, asset] of assets.entries()) {
    const filePath = target.paths[index];
    if (!filePath) continue;
    await writeFile(filePath, Buffer.from(asset.base64, "base64"));
    outputPaths.push(filePath);
  }

  return outputPaths;
}

async function resolveImageTargets(
  outputPath: string,
  assets: GeneratedImageAsset[],
): Promise<{ directory: string; paths: string[] }> {
  const normalized = path.resolve(outputPath);
  const outputStat = await stat(normalized).catch(() => null);
  const ext = path.extname(normalized);
  const directoryMode = outputStat?.isDirectory() || !ext;
  if (directoryMode) {
    return {
      directory: normalized,
      paths: assets.map((asset, index) =>
        path.join(normalized, `image-${index + 1}${extensionForAsset(asset)}`),
      ),
    };
  }

  const directory = path.dirname(normalized);
  const basename = path.basename(normalized, ext);
  return {
    directory,
    paths: assets.map((asset, index) =>
      index === 0 ? normalized : path.join(directory, `${basename}-${index + 1}${ext}`),
    ),
  };
}

function extensionForAsset(asset: GeneratedImageAsset): string {
  const mime = asset.mimeType.toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("png")) return ".png";

  try {
    const pathname = new URL(asset.src).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    // Fall back to PNG when ChatGPT serves blob URLs or opaque CDN paths.
  }

  return ".png";
}

async function isStopButtonVisible(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)}))`,
    returnByValue: true,
  });
  return Boolean(result?.value);
}

async function isImageTurnFinished(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: buildImageFinishedExpression(minTurnIndex),
    returnByValue: true,
  });
  return Boolean(result?.value);
}

function buildEnsureImageModeExpression(aspectRatio: ImageAspectRatio | undefined): string {
  return `(() => {
    ${buildClickDispatcher()}
    const INPUT_SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
    const TARGET_ASPECT = ${JSON.stringify(aspectRatio ?? null)};
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const label = (node) =>
      normalize([node?.textContent, node?.getAttribute?.('aria-label'), node?.getAttribute?.('title')].filter(Boolean).join(' '));
    const rootSelector = 'form,[data-testid*="composer"],[data-testid*="prompt"]';
    const sidebarSelector = 'nav, aside, [data-testid*="sidebar"], [data-testid^="history-item"]';
    const composerRootFor = (node) =>
      node?.closest?.('form') ||
      node?.closest?.('[data-testid*="composer"]:not(button),[data-testid*="prompt"]:not(button)');
    const inputNode = INPUT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find(visible);
    const inputRoot = composerRootFor(inputNode);
    const addButtons = Array.from(document.querySelectorAll('button,[role="button"]')).filter((node) => {
      if (!visible(node) || node.closest?.(sidebarSelector)) return false;
      return label(node).includes('add files and more');
    });
    const addButtonRoot = addButtons
      .map((node) => composerRootFor(node))
      .find((node) => node && visible(node));
    const composerRoot =
      addButtonRoot ||
      inputRoot ||
      Array.from(document.querySelectorAll(rootSelector)).find((node) => visible(node) && !(node instanceof HTMLButtonElement)) ||
      null;
    const inComposer = (node) => Boolean(node && composerRoot && composerRoot.contains(node) && !node.closest?.(sidebarSelector));
    const selectedImage = Array.from((composerRoot || document).querySelectorAll('button,[role="button"],[role="menuitemradio"],[role="menuitemcheckbox"]'))
      .find((node) => {
        if (!visible(node) || !inComposer(node)) return false;
        const text = label(node);
        const selected =
          text.includes('click to remove') ||
          node.getAttribute?.('aria-checked') === 'true' ||
          node.getAttribute?.('aria-pressed') === 'true' ||
          normalize(node.getAttribute?.('data-state')) === 'checked';
        return selected && (text === 'image' || text.startsWith('image,') || text.includes(' image'));
      });
    if (!selectedImage) {
      const menuRoots = Array.from(document.querySelectorAll('[role="menu"], [data-radix-collection-root], [data-state="open"]'))
        .filter((node) => visible(node) && !node.closest?.(sidebarSelector));
      const createImage = menuRoots
        .flatMap((root) => Array.from(root.querySelectorAll('[role="menuitemradio"],[role="menuitemcheckbox"],[role="menuitem"],button')))
        .find((node) => {
          if (!visible(node)) return false;
          const text = label(node);
          return text === 'create image' || text.startsWith('create image ');
        });
      if (createImage instanceof HTMLElement) {
        if (createImage.getAttribute('aria-checked') !== 'true') {
          dispatchClickSequence(createImage);
        }
        return { status: 'clicked-image' };
      }
      const addButton = addButtons.find((node) => !composerRoot || inComposer(node)) || addButtons[0];
      if (!(addButton instanceof HTMLElement)) return { status: 'button-missing' };
      dispatchClickSequence(addButton);
      return { status: 'opened-menu' };
    }

    if (!TARGET_ASPECT) {
      return { status: 'ready' };
    }

    const aspectMatches = (text) => {
      if (TARGET_ASPECT === '1:1') return text.includes('1:1') || text.includes('square');
      if (TARGET_ASPECT === '3:4') return text.includes('3:4') || text.includes('portrait');
      if (TARGET_ASPECT === '9:16') return text.includes('9:16') || text.includes('story');
      if (TARGET_ASPECT === '4:3') return text.includes('4:3') || text.includes('landscape');
      if (TARGET_ASPECT === '16:9') return text.includes('16:9') || text.includes('widescreen');
      return false;
    };
    const aspectButton = Array.from((composerRoot || document).querySelectorAll('button,[role="button"]'))
      .find((node) => {
        if (!visible(node) || !inComposer(node)) return false;
        const text = label(node);
        return text.includes('choose image aspect ratio') || (text.includes('image') && text.includes('ratio'));
      });
    if (!(aspectButton instanceof HTMLElement)) {
      return { status: 'aspect-missing' };
    }
    if (aspectMatches(label(aspectButton))) {
      return { status: 'ready' };
    }
    const aspectMenuRoots = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-collection-root], [data-state="open"]'))
      .filter((node) => visible(node) && !node.closest?.(sidebarSelector));
    const aspectItem = aspectMenuRoots
      .flatMap((root) => Array.from(root.querySelectorAll('[role="menuitemradio"],[role="option"],[role="menuitem"],button')))
      .find((node) => visible(node) && aspectMatches(label(node)));
    if (aspectItem instanceof HTMLElement) {
      dispatchClickSequence(aspectItem);
      return { status: 'selected-aspect' };
    }
    dispatchClickSequence(aspectButton);
    return { status: 'opened-aspect-menu' };
  })()`;
}

function buildImageSnapshotExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const ASSISTANT_SELECTOR = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
    const imageSelector = 'img,picture img';
    const excludedSelector = 'nav, aside, form, [data-testid*="sidebar"], [data-testid*="composer"], [data-testid*="avatar"]';
    const visibleImage = (node) => {
      if (!(node instanceof HTMLImageElement)) return false;
      if (node.closest?.(excludedSelector)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 128 || rect.height < 128) return false;
      if (node.naturalWidth > 0 && node.naturalHeight > 0 && (node.naturalWidth < 128 || node.naturalHeight < 128)) return false;
      const src = node.currentSrc || node.src || '';
      if (!src || src.startsWith('data:image/svg')) return false;
      return true;
    };
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    let root = null;
    let turnIndex = null;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (MIN_TURN_INDEX >= 0 && i < MIN_TURN_INDEX) break;
      const turn = turns[i];
      if (isAssistantTurn(turn)) {
        root = turn.querySelector(ASSISTANT_SELECTOR) || turn;
        turnIndex = i;
        break;
      }
    }
    if (!root) {
      root =
        document.querySelector('section[data-testid="screen-threadFlyOut"]') ||
        document.querySelector('[data-testid="chat-thread"]') ||
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.body;
    }
    const images = [];
    const seen = new Set();
    for (const image of Array.from(root.querySelectorAll(imageSelector))) {
      if (!visibleImage(image)) continue;
      const src = image.currentSrc || image.src || '';
      if (seen.has(src)) continue;
      seen.add(src);
      const rect = image.getBoundingClientRect();
      images.push({
        src,
        width: Math.round(image.naturalWidth || rect.width),
        height: Math.round(image.naturalHeight || rect.height),
        alt: image.alt || '',
      });
    }
    if (images.length === 0) return null;
    const text = (root.innerText || root.textContent || '').trim();
    const html = root.innerHTML || '';
    const messageId = root.getAttribute?.('data-message-id') || null;
    const turnId = root.getAttribute?.('data-testid') || null;
  return { text, html, messageId, turnId, turnIndex, images };
  })()`;
}

function buildImageFinishedExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const ASSISTANT_SELECTOR = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
    const FINISHED_SELECTOR = ${JSON.stringify(FINISHED_ACTIONS_SELECTOR)};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (MIN_TURN_INDEX >= 0 && i < MIN_TURN_INDEX) break;
      const turn = turns[i];
      if (!isAssistantTurn(turn)) continue;
      return Boolean(turn.querySelector(FINISHED_SELECTOR)) || !document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)});
    }
    return !document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)});
  })()`;
}

function buildFetchImagesExpression(srcs: string[]): string {
  return `(async () => {
    const srcs = ${JSON.stringify(srcs)};
    const toBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i += 1) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    };
    const images = [];
    for (const src of srcs) {
      try {
        const response = await fetch(src, { credentials: 'include' });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        const probe = Array.from(document.querySelectorAll('img')).find((image) => (image.currentSrc || image.src || '') === src);
        const rect = probe?.getBoundingClientRect?.();
        images.push({
          src,
          mimeType: response.headers.get('content-type') || 'image/png',
          base64: toBase64(buffer),
          width: Math.round(probe?.naturalWidth || rect?.width || 0),
          height: Math.round(probe?.naturalHeight || rect?.height || 0),
          alt: probe?.alt || '',
        });
      } catch {
        // Skip failed fetches; Node will raise if all generated images fail to download.
      }
    }
    return { images };
  })()`;
}
