import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

export const DEFAULT_ORACLE_BROWSER_PROFILE_DIR = path.join(getOracleHomeDir(), "chrome");
export const DEFAULT_ORACLE_BROWSER_DEBUG_PORT = 9222;
