import { describe, it, expect } from "bun:test";
import { resolveMarkdownSplitSections } from "../../src/resolvers/markdown-split-sections.js";

describe("markdown_split_sections resolver", () => {
  it("splits a doc on H2 and H3 headings and emits markdownSections", async () => {
    const content = [
      "# Title (H1, skipped as a section delimiter — body still gone)",
      "",
      "intro line",
      "",
      "## Section One",
      "",
      "body of one",
      "",
      "### Sub of one",
      "",
      "sub body",
      "",
      "## Section Two",
      "",
      "body of two",
    ].join("\n");

    const result = await resolveMarkdownSplitSections({
      type: "markdown_split_sections",
      content,
      doc_path: "test.md",
    });
    expect(result.shape).toBe("markdownSections");
    const body = result.body as {
      sections: Array<{ heading: string; level: number; heading_slug: string; body_excerpt: string }>;
      section_count: number;
      doc_path: string;
    };
    // H2/H3 split; H1 is not a section boundary so we expect 3 sections.
    expect(body.section_count).toBe(3);
    expect(body.sections[0]!.heading).toBe("Section One");
    expect(body.sections[0]!.level).toBe(2);
    expect(body.sections[0]!.body_excerpt).toContain("body of one");
    expect(body.sections[1]!.heading).toBe("Sub of one");
    expect(body.sections[1]!.level).toBe(3);
    expect(body.sections[2]!.heading).toBe("Section Two");
    expect(body.sections[2]!.body_excerpt).toContain("body of two");
    expect(body.doc_path).toBe("test.md");
  });

  it("emits unique heading_slugs (handles duplicates)", async () => {
    const content = [
      "## Same Heading",
      "first",
      "## Same Heading",
      "second",
    ].join("\n");
    const result = await resolveMarkdownSplitSections({
      type: "markdown_split_sections",
      content,
      doc_path: "dup.md",
    });
    const body = result.body as { sections: Array<{ heading_slug: string }> };
    expect(body.sections[0]!.heading_slug).toBe("same-heading");
    expect(body.sections[1]!.heading_slug).toBe("same-heading-1");
  });

  it("caps body_excerpt at maxSectionChars and marks truncation", async () => {
    const longBody = "x".repeat(5000);
    const content = `## Long Section\n${longBody}`;
    const result = await resolveMarkdownSplitSections({
      type: "markdown_split_sections",
      content,
      doc_path: "long.md",
      maxSectionChars: 100,
    });
    const body = result.body as { sections: Array<{ body_excerpt: string }> };
    expect(body.sections[0]!.body_excerpt.length).toBeLessThanOrEqual(
      100 + "\n…[truncated]".length,
    );
    expect(body.sections[0]!.body_excerpt).toContain("…[truncated]");
  });

  it("respects maxSections cap", async () => {
    const sections = Array.from({ length: 20 }, (_, i) => `## Sec${i}\nbody${i}`).join("\n");
    const result = await resolveMarkdownSplitSections({
      type: "markdown_split_sections",
      content: sections,
      doc_path: "many.md",
      maxSections: 5,
    });
    const body = result.body as { section_count: number };
    expect(body.section_count).toBe(5);
  });

  it("returns structuredError when neither content nor doc_path is provided", async () => {
    const result = await resolveMarkdownSplitSections({
      type: "markdown_split_sections",
    });
    expect(result.shape).toBe("structuredError");
  });

  it("returns structuredError on missing doc_path file", async () => {
    const result = await resolveMarkdownSplitSections({
      type: "markdown_split_sections",
      doc_path: "/tmp/definitely-does-not-exist-xyz-12345.md",
    });
    expect(result.shape).toBe("structuredError");
  });
});
