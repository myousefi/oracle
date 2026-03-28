import type { EngineMode } from "./engine.js";
import type { ModelName } from "../oracle.js";
import { isProModel } from "../oracle/modelResolver.js";

export function shouldDetachSession({
  // Params kept for policy tweaks.
  engine,
  model,
  waitPreference,
  disableDetachEnv,
}: {
  engine: EngineMode;
  model: ModelName;
  waitPreference: boolean;
  disableDetachEnv: boolean;
}): boolean {
  if (disableDetachEnv) return false;
  // Allow explicit --no-wait for browser runs; otherwise keep them inline so failures surface.
  if (engine === 'browser') return waitPreference === false;
  // Only Pro-tier API runs should start detached by default.
  if (isProModel(model) && engine === 'api') return true;
  return false;
}
