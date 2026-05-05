import fs from "node:fs";
import path from "node:path";

// When running directly from a git checkout, we want `dist/*` entrypoints to be
// executable so users can symlink them into PATH (without a wrapper script).
// This is intentionally best-effort and should never fail the build.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const targets = [
  "dist/bin/oracle-cli.js",
  "dist/bin/oracle-mcp.js",
  "dist/scripts/run-cli.js",
  "dist/scripts/run-mcp.js",
].map((p) => path.join(root, p));

if (process.platform === "win32") {
  process.exit(0);
}

for (const target of targets) {
  try {
    if (!fs.existsSync(target)) continue;
    // 0o755 so the file remains runnable even if umask is restrictive.
    fs.chmodSync(target, 0o755);
  } catch {
    // Best effort: never fail build for chmod issues.
  }
}
