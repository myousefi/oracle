import { describe, expect, it } from "vitest";
import {
  composeGeminiReportMarkdown,
  normalizeGeminiReport,
} from "../../src/gemini-web/deepResearchExecutor.js";

describe("gemini deep research report helpers", () => {
  it("normalizes report content and source groups", () => {
    const report = normalizeGeminiReport({
      title: "  Practical AMD Briefing  ",
      text: "Final report body",
      html: "<h1>Practical AMD Briefing</h1><p>Final report body</p>",
      headings: [
        { level: 1, text: " Practical AMD Briefing " },
        { level: 2, text: " Executive Summary " },
      ],
      tables: [
        {
          caption: " Table 1 ",
          rows: [
            [" Column A ", " Column B "],
            [" Value 1 ", " Value 2 "],
          ],
        },
      ],
      sources: [
        {
          title: " Sources used in the report ",
          links: [
            {
              title:
                "amd.com AMD Quark Model Optimization Library Now Available as Open-Source Opens in a new window",
              url: "https://www.amd.com/en/developer/resources/technical-articles/2025/amd-quark.html",
              domain: "amd.com",
            },
            {
              title:
                "amd.com AMD Quark Model Optimization Library Now Available as Open-Source Opens in a new window",
              url: "https://www.amd.com/en/developer/resources/technical-articles/2025/amd-quark.html",
              domain: "amd.com",
            },
          ],
        },
        {
          title: " Sources read but not used in the report ",
          links: [
            {
              title: " rocm.docs.amd.com xDiT diffusion inference - AMD ROCm documentation ",
              url: "https://rocm.docs.amd.com/en/latest/how-to/rocm-for-ai/inference/xdit-diffusion-inference.html",
              domain: "rocm.docs.amd.com",
            },
          ],
        },
      ],
    });

    expect(report.title).toBe("Practical AMD Briefing");
    expect(report.headings).toEqual([
      { level: 1, text: "Practical AMD Briefing" },
      { level: 2, text: "Executive Summary" },
    ]);
    expect(report.tables).toEqual([
      {
        index: 1,
        caption: "Table 1",
        rows: [
          ["Column A", "Column B"],
          ["Value 1", "Value 2"],
        ],
      },
    ]);
    expect(report.sources).toEqual([
      {
        title: "Sources used in the report",
        links: [
          {
            title: "AMD Quark Model Optimization Library Now Available as Open-Source",
            url: "https://www.amd.com/en/developer/resources/technical-articles/2025/amd-quark.html",
            domain: "amd.com",
          },
        ],
      },
      {
        title: "Sources read but not used in the report",
        links: [
          {
            title: "xDiT diffusion inference - AMD ROCm documentation",
            url: "https://rocm.docs.amd.com/en/latest/how-to/rocm-for-ai/inference/xdit-diffusion-inference.html",
            domain: "rocm.docs.amd.com",
          },
        ],
      },
    ]);
  });

  it("renders markdown with thoughts and grouped sources", () => {
    const markdown = composeGeminiReportMarkdown(
      {
        title: "Practical AMD Briefing",
        text: "Final report body",
        html: "<p>Final report body</p>",
        headings: [],
        tables: [],
        sources: [
          {
            title: "Sources used in the report",
            links: [
              {
                title: "AMD Quark Model Optimization Library Now Available as Open-Source",
                url: "https://www.amd.com/en/developer/resources/technical-articles/2025/amd-quark.html",
                domain: "amd.com",
              },
            ],
          },
        ],
      },
      "Investigating AMD diffusion tooling",
    );

    expect(markdown).toContain("## Thinking");
    expect(markdown).toContain("Investigating AMD diffusion tooling");
    expect(markdown).toContain("## Response");
    expect(markdown).toContain("Final report body");
    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("### Sources used in the report");
    expect(markdown).toContain(
      "- [AMD Quark Model Optimization Library Now Available as Open-Source](https://www.amd.com/en/developer/resources/technical-articles/2025/amd-quark.html)",
    );
  });
});
