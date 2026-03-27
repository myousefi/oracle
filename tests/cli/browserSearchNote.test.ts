import { describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { enforceBrowserSearchFlag } from '../../bin/oracle-cli.js';
import type { RunOracleOptions } from '../../src/oracle.js';
import type { SessionMode } from '../../src/sessionStore.js';

const makeRunOptions = (search: boolean | undefined): RunOracleOptions => ({
  prompt: 'hi',
  model: 'gpt-5.1',
  file: [],
  search,
  heartbeatIntervalMs: 30000,
});

describe('browser search note', () => {
  it('forces search on for ChatGPT browser runs', () => {
    const logSpy = vi.fn();
    const opts = makeRunOptions(false);
    opts.model = 'gpt-5.4';
    enforceBrowserSearchFlag(opts, 'browser' as SessionMode, logSpy);
    expect(logSpy).toHaveBeenCalledWith(chalk.dim('Note: ChatGPT browser runs always enable search; overriding search=false.'));
    expect(opts.search).toBe(true);
  });

  it('still ignores search=false for non-ChatGPT browser runs', () => {
    const logSpy = vi.fn();
    const opts = makeRunOptions(false);
    opts.model = 'gemini-3-pro';
    enforceBrowserSearchFlag(opts, 'browser' as SessionMode, logSpy);
    expect(logSpy).toHaveBeenCalledWith(chalk.dim('Note: search is not available in browser engine; ignoring search=false.'));
    expect(opts.search).toBeUndefined();
  });

  it('leaves search untouched for api', () => {
    const logSpy = vi.fn();
    const opts = makeRunOptions(false);
    enforceBrowserSearchFlag(opts, 'api' as SessionMode, logSpy);
    expect(logSpy).not.toHaveBeenCalled();
    expect(opts.search).toBe(false);
  });
});
