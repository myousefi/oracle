# GPT-5.4 Default Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate Oracle from GPT-5.2-era defaults and browser labels to GPT-5.4-era behavior, making `gpt-5.4-pro` the default and resolving legacy 5.2/5.1 GPT aliases to current models.

**Architecture:** Update the canonical model registry, alias resolution, and ChatGPT browser-label mapping in source first, then refresh the tests, docs, and built `dist` output so the symlinked `oracle` binary reflects the new behavior immediately. Use explicit alias mappings so legacy user inputs still work while the surfaced defaults and labels move to the current OpenAI model family.

**Tech Stack:** TypeScript, Vitest, pnpm, browser-mode model picker logic

---

### Task 1: Lock the new model mapping in tests

**Files:**
- Modify: `tests/runOptions.test.ts`
- Modify: `tests/cli/options.test.ts`
- Modify: `tests/cli/browserConfig.test.ts`
- Modify: `tests/browser/modelSelection.test.ts`
- Modify: `tests/cli/runOracle/runOracle.request-payload.test.ts`
- Modify: `tests/cli/runOracle/runOracle.logging.test.ts`
- Modify: `tests/cli/runOracle/runOracle.timeouts-and-errors.test.ts`

**Step 1: Update default-model expectations**

Require omitted `--model` cases to resolve to `gpt-5.4-pro`.

**Step 2: Update alias-resolution expectations**

Require legacy GPT aliases to resolve as follows:
- `gpt-5.1-pro`, `gpt-5.2-pro`, `gpt-5-pro`, and generic Pro labels -> `gpt-5.4-pro`
- `gpt-5.1`, `gpt-5.2`, and ambiguous non-pro GPT labels -> `gpt-5.4`
- `gpt-5.2-thinking` -> `gpt-5.4-thinking`
- `gpt-5.2-instant` -> `gpt-5.3-instant`

**Step 3: Run focused tests to verify RED**

Run: `pnpm vitest run tests/runOptions.test.ts tests/cli/options.test.ts tests/cli/browserConfig.test.ts tests/browser/modelSelection.test.ts tests/cli/runOracle/runOracle.request-payload.test.ts tests/cli/runOracle/runOracle.logging.test.ts tests/cli/runOracle/runOracle.timeouts-and-errors.test.ts`
Expected: FAIL against the current 5.2-era implementation.

### Task 2: Implement the source migration

**Files:**
- Modify: `src/oracle/types.ts`
- Modify: `src/oracle/config.ts`
- Modify: `src/cli/options.ts`
- Modify: `src/cli/browserConfig.ts`
- Modify: `src/browser/constants.ts`
- Modify: `src/browser/actions/modelSelection.ts`
- Modify: `src/cli/help.ts`
- Modify: `bin/oracle-cli.ts`
- Modify: `src/oracle/run.ts`
- Modify: `src/oracle/errors.ts`
- Modify: `src/oracle/gemini.ts`
- Modify: `src/cli/runOptions.ts`
- Modify: `src/browser/prompt.ts`
- Modify: `src/cli/dryRun.ts`

**Step 1: Add canonical GPT-5.4-era models**

Introduce `gpt-5.4`, `gpt-5.4-thinking`, `gpt-5.4-pro`, and `gpt-5.3-instant` in the registry and types.

**Step 2: Migrate aliases and browser labels**

Make legacy GPT-5.1/5.2 inputs normalize to the current model family and update browser labels to `GPT-5.4 Thinking`, `GPT-5.4 Pro`, and `GPT-5.3 Instant`.

**Step 3: Update user-facing messages**

Refresh help text, timeout notes, alias notes, and error guidance so they no longer present 5.2 as current.

### Task 3: Refresh supporting docs and skills

**Files:**
- Modify: `README.md`
- Modify: `skills/oracle/SKILL.md`
- Modify: `docs/browser-mode.md`
- Modify: `docs/configuration.md`
- Modify: `docs/openai-endpoints.md`
- Modify: `docs/testing.md`
- Modify: `docs/manual-tests.md`
- Modify: `docs/debug/remote-chrome.md`
- Modify: `docs/testing/mcp-smoke.md`
- Modify: `docs/openrouter.md`
- Modify: `docs/anthropic.md`
- Modify: `docs/multimodel.md`
- Modify: `CHANGELOG.md`

**Step 1: Replace current-version references**

Update docs that present 5.2 as the current default or current browser label.

**Step 2: Preserve legacy notes only where needed**

Keep legacy references only when documenting alias compatibility or historical behavior.

### Task 4: Verify GREEN and rebuild the live CLI

**Files:**
- Modify: `dist/**` via build output

**Step 1: Run the focused tests again**

Run: `pnpm vitest run tests/runOptions.test.ts tests/cli/options.test.ts tests/cli/browserConfig.test.ts tests/browser/modelSelection.test.ts tests/cli/runOracle/runOracle.request-payload.test.ts tests/cli/runOracle/runOracle.logging.test.ts tests/cli/runOracle/runOracle.timeouts-and-errors.test.ts`
Expected: PASS

**Step 2: Build the CLI**

Run: `pnpm run build`
Expected: build succeeds and refreshes `dist/`

**Step 3: Verify the active binary**

Run: `oracle --help | sed -n '1,60p'`
Expected: help text advertises `gpt-5.4-pro` as the default/current Pro path.

**Step 4: Verify runtime normalization**

Run: `oracle --dry-run json -p "migration check prompt" --model gpt-5.2-pro`
Expected: preview normalizes to the GPT-5.4-era target rather than keeping a 5.2 current model.
