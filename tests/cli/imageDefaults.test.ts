import { describe, expect, test } from "vitest";
import { applyImageGenerationDefaults } from "../../src/cli/imageDefaults.js";

describe("applyImageGenerationDefaults", () => {
  test("uses OpenAI thinking standard for singular image generation without a model", () => {
    const options = { generateImage: "out.png" };

    applyImageGenerationDefaults(options, false);

    expect(options).toEqual({
      model: "gpt-5.5-thinking",
      browserThinkingTime: "standard",
      generateImage: undefined,
      generateImages: true,
      output: "out.png",
    });
  });

  test("keeps explicit model image generation on the existing Gemini path", () => {
    const options = { model: "gemini-3.1-pro", generateImage: "out.png" };

    applyImageGenerationDefaults(options, true);

    expect(options).toEqual({ model: "gemini-3.1-pro", generateImage: "out.png" });
  });

  test("does not replace an explicit output path", () => {
    const options = { generateImage: "ignored.png", output: "chosen.png" };

    applyImageGenerationDefaults(options, false);

    expect(options.output).toBe("chosen.png");
  });
});
