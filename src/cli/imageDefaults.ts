import { CURRENT_GPT_THINKING_MODEL } from "../oracle.js";
import type { ThinkingTimeLevel } from "../oracle.js";

export interface ImageDefaultOptions {
  model?: string;
  generateImages?: boolean;
  generateImage?: string;
  editImage?: string;
  output?: string;
  browserThinkingTime?: ThinkingTimeLevel;
}

export function applyImageGenerationDefaults(
  options: ImageDefaultOptions,
  modelProvided: boolean,
): void {
  if (modelProvided || options.editImage) return;
  if (!options.generateImages && !options.generateImage) return;

  options.model = CURRENT_GPT_THINKING_MODEL;
  options.browserThinkingTime ??= "standard";

  if (options.generateImage && !options.generateImages) {
    options.output ??= options.generateImage;
    options.generateImage = undefined;
    options.generateImages = true;
  }
}
