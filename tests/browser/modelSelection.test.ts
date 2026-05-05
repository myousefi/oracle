import { describe, expect, it } from "vitest";
import { buildModelMatchersLiteralForTest } from "../../src/browser/actions/modelSelection.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

describe("browser model selection matchers", () => {
  it("includes rich tokens for gpt-5.5", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5");
    expectContains(labelTokens, "gpt-5.5");
    expectContains(labelTokens, "gpt-5-5");
    expectContains(labelTokens, "gpt55");
    expectContains(labelTokens, "chatgpt 5.5");
    expectContains(testIdTokens, "gpt-5-5");
    expect(
      testIdTokens.some(
        (t) => t.includes("gpt-5.5") || t.includes("gpt-5-5") || t.includes("gpt55"),
      ),
    ).toBe(true);
  });

  it("includes pro/research tokens for gpt-5.5-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-pro");
    expect(labelTokens.some((t) => t.includes("pro") || t.includes("research"))).toBe(true);
    expectContains(testIdTokens, "gpt-5.5-pro");
    expect(testIdTokens.some((t) => t.includes("model-switcher-gpt-5.5-pro"))).toBe(true);
  });

  it("includes pro + 5.5 tokens for gpt-5.5-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.5-pro") || t.includes("gpt-5-5-pro"))).toBe(
      true,
    );
  });

  it("includes thinking tokens for gpt-5.5-thinking", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-thinking");
    expect(labelTokens.some((t) => t.includes("thinking"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-5-thinking");
    expect(testIdTokens).toContain("gpt-5.5-thinking");
  });

  it("includes instant tokens for gpt-5.3-instant", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.3-instant");
    expect(labelTokens.some((t) => t.includes("instant"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.3") || t.includes("5-3"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-3-instant");
    expect(testIdTokens).toContain("gpt-5.3-instant");
  });
});
