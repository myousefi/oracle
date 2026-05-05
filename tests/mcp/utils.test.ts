import { describe, expect, test } from "vitest";
import { mapConsultToRunOptions } from "../../src/mcp/utils.js";

describe("mapConsultToRunOptions", () => {
  test("rejects multi-model selections", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() =>
      mapConsultToRunOptions({
        prompt: "multi",
        files: [],
        model: "gpt-5.2-pro",
        models: ["gemini-3-pro"],
        userConfig: undefined,
        env,
      }),
    ).toThrow("Multi-model execution is not supported in browser-only mode.");
  });
});
