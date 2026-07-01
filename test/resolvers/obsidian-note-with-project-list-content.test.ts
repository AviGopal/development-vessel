import { describe, it, expect } from "bun:test";
import { resolveObsidianNoteWithProjectListContent } from "../../src/resolvers/obsidian-note-with-project-list-content.js";

describe("obsidian_note_with_project_list_content resolver", () => {
  it("returns a well-formed result for the obsidian:note with project list content shape", async () => {
    const r = await resolveObsidianNoteWithProjectListContent({ type: "obsidian_note_with_project_list_content" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
