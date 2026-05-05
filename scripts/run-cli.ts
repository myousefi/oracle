#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rawArgs = process.argv.slice(2);
const args: string[] = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "../bin/oracle-cli.js");

function canUseBun(): boolean {
  // If we are already running under Bun, prefer staying on it.
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

// Keep argv shape runtime-agnostic:
// Node: `node <script> ...`
// Bun:  `bun <script> ...`
const child = spawn(runtime, [cliEntry, ...args], {
  stdio: "inherit",
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
