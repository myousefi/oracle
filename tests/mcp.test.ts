import { describe, it, expect } from "vitest";
import { mapConsultToRunOptions } from "../src/mcp/utils.js";

describe('mcp utils', () => {
  it('maps browser defaults', () => {
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({ prompt: 'hi', files: [], model: 'gpt-5.2-pro' });
    expect(resolvedEngine).toBe('browser');
    expect(runOptions.model).toBe('gpt-5.2-pro');
  });

  it("infers browser labels", () => {
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "hi",
      files: [],
      model: "5.1 instant",
      engine: "browser",
    });
    expect(resolvedEngine).toBe("browser");
    expect(runOptions.model).toBe("gpt-5.2");
  });
});
