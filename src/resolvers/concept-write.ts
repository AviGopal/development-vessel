import type { ResolverResult } from "./types.js";

export async function resolveConceptWrite(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const phrase = typeof pointer.phrase === "string" ? pointer.phrase : "alpha beta gamma";
  const wordCount = phrase.split(/\s+/).filter(Boolean).length;

  const substrateBaseUrl = process.env.SUBSTRATE_BASE_URL;
  if (!substrateBaseUrl) {
    throw new Error("SUBSTRATE_BASE_URL not configured");
  }

  const memoryRes = await fetch(`${substrateBaseUrl}/memory/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ content: String(wordCount), tags: ["concept_write", "word_count"] }),
  });

  if (!memoryRes.ok) {
    const errorText = await memoryRes.text();
    throw new Error(`Failed to persist memory note: ${memoryRes.status} ${errorText}`);
  }

  const memoryJson = (await memoryRes.json()) as { id?: string; noteId?: string };
  const noteId = memoryJson.id ?? memoryJson.noteId ?? "unknown";

  return { shape: "concept_write", body: { phrase, wordCount, memoryNoteId: noteId } };
}
