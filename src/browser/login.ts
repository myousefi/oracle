import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { resolveBrowserConfig } from "./config.js";
import { launchChrome, connectWithNewTab } from "./chromeLifecycle.js";
import {
  cleanupStaleProfileState,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import {
  DEFAULT_ORACLE_BROWSER_DEBUG_PORT,
  DEFAULT_ORACLE_BROWSER_PROFILE_DIR,
} from "./profileDefaults.js";

export interface BrowserLoginOptions {
  url?: string;
  profileDir?: string | null;
  debugPort?: number | null;
  logger?: BrowserLogger;
}

export interface BrowserLoginResult {
  port: number;
  profileDir: string;
  reused: boolean;
}

export async function ensureBrowserLoginProfile({
  url = CHATGPT_URL,
  profileDir,
  debugPort,
  logger = (() => {}) as BrowserLogger,
}: BrowserLoginOptions = {}): Promise<BrowserLoginResult> {
  const resolvedProfileDir = profileDir
    ? path.resolve(profileDir)
    : DEFAULT_ORACLE_BROWSER_PROFILE_DIR;
  await mkdir(resolvedProfileDir, { recursive: true });

  const preferredPort = debugPort ?? DEFAULT_ORACLE_BROWSER_DEBUG_PORT;
  const existingPort = await readDevToolsPort(resolvedProfileDir);
  if (existingPort) {
    const reachable = await verifyDevToolsReachable({ port: existingPort });
    if (reachable.ok) {
      logger(
        `Found running Chrome for login profile at ${resolvedProfileDir} (port ${existingPort}).`,
      );
      await openLoginTab(existingPort, url, logger);
      return { port: existingPort, profileDir: resolvedProfileDir, reused: true };
    }
    logger(
      `DevTools port ${existingPort} unreachable (${reachable.error}); launching fresh Chrome.`,
    );
    await cleanupStaleProfileState(resolvedProfileDir, logger, { lockRemovalMode: "never" });
  }

  const resolvedConfig = resolveBrowserConfig({
    url,
    manualLogin: true,
    manualLoginProfileDir: resolvedProfileDir,
    debugPort: preferredPort,
    keepBrowser: true,
  });

  const chrome = await launchChrome(resolvedConfig, resolvedProfileDir, logger);
  if (chrome.port) {
    await writeDevToolsActivePort(resolvedProfileDir, chrome.port);
  }
  if (chrome.pid) {
    await writeChromePid(resolvedProfileDir, chrome.pid);
  }

  await openLoginTab(chrome.port, url, logger, chrome.host);

  return { port: chrome.port, profileDir: resolvedProfileDir, reused: false };
}

async function openLoginTab(
  port: number,
  url: string,
  logger: BrowserLogger,
  host?: string,
): Promise<void> {
  try {
    const connection = await connectWithNewTab(port, logger, url, host);
    await connection.client.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to open login tab (${message}); continue in existing Chrome window.`);
  }
}
