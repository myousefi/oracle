#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rawArgs = process.argv.slice(2);
const args: string[] = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpEntry = path.join(here, "../bin/oracle-mcp.js");

function canUseBun(): boolean {
  if (typeof (process.versions as Record<string, string | undefined>)?.bun === "string") {
    return true;
  }
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

type RuntimeChoice = "bun" | "node";
function resolveRuntimeChoice(): RuntimeChoice {
  const forced = (process.env.ORACLE_RUNTIME ?? "").trim().toLowerCase();
  if (forced === "bun") return "bun";
  if (forced === "node") return "node";
  return canUseBun() ? "bun" : "node";
}

const runtime = resolveRuntimeChoice() === "bun" ? "bun" : process.execPath;

const child = spawn(runtime, [mcpEntry, ...args], {
  stdio: "inherit",
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
