export type EngineMode = 'api' | 'browser';

export function defaultWaitPreference(model: string, engine: EngineMode): boolean {
  // Browser runs are expected to be interactive and are kept attached unless explicitly detached.
  return true;
}

/**
 * Determine which engine to use.
 *
 * In this branch, execution is browser-only. The API engine is disabled and
 * all valid requests use browser automation.
 *
 * Precedence:
 * 1) Legacy --browser flag keeps this as browser.
 * 2) Any explicit --engine value (including invalid legacy values) maps to browser.
 * 3) Environment and key presence are ignored.
 */
export function resolveEngine(
  {
    engine,
    browserFlag,
    env,
  }: { engine?: EngineMode; browserFlag?: boolean; env: NodeJS.ProcessEnv },
): EngineMode {
  if (browserFlag || engine === 'browser' || engine === 'api') {
    return 'browser';
  }
  return 'browser';
}
