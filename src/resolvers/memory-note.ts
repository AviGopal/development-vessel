/**
 * memoryNote resolver — substrate-resident memory store.
 *
 * Closes IAL gate 27.3.j.1 (memory closure): after this resolver exists and
 * the substrate imports operator memory, the system can read/write knowledge
 * without reaching for operator-side files.
 *
 * Storage: WORKSPACE_ROOT/memory/notes.json — a flat JSON array of MemoryNote
 * records. Kept intentionally simple (no SurrealDB yet). The file is written
 * atomically (tmp → rename). Reads return a filtered subset.
 *
 * Write path (memoryNote_write): append or upsert a note by id.
 * Read path (memoryNote): query by type, title prefix, or provenance tag.
 *
 * The substrate authors notes via activity execution (ribosome extraction,
 * operator-import script, and future propose-spec activities). This resolver
 * is the storage primitive; the intelligence lives in activities.
 */

import { WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryNote {
  id: string;
  type: "finding" | "feedback" | "reference" | "project";
  title: string;
  body: string;
  provenance_trace_ids?: string[];
  confidence_weight?: number; // 0.0–1.0; operator-imported notes default to 0.7
  last_validated_at?: string;
  pending_sync?: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemoryNoteReadPointer {
  type: "memoryNote";
  id?: string;
  note_type?: MemoryNote["type"];
  title_prefix?: string;
  provenance_tag?: string;
  limit?: number;
}

export interface MemoryNoteWritePointer {
  type: "memoryNote_write";
  note: Omit<MemoryNote, "created_at" | "updated_at"> & {
    created_at?: string;
    updated_at?: string;
  };
}

const NOTES_PATH = () => join(WORKSPACE_ROOT, "memory", "notes.json");

async function loadNotes(): Promise<MemoryNote[]> {
  try {
    const raw = await readFile(NOTES_PATH(), "utf-8");
    return JSON.parse(raw) as MemoryNote[];
  } catch {
    return [];
  }
}

async function saveNotes(notes: MemoryNote[]): Promise<void> {
  const dir = join(WORKSPACE_ROOT, "memory");
  await mkdir(dir, { recursive: true });
  const tmp = NOTES_PATH() + ".tmp";
  await writeFile(tmp, JSON.stringify(notes, null, 2), "utf-8");
  await rename(tmp, NOTES_PATH());
}

export async function resolveMemoryNote(
  pointer: MemoryNoteReadPointer,
): Promise<ResolverResult> {
  const notes = await loadNotes();
  const limit = pointer.limit ?? 50;

  let results = notes;

  if (pointer.id) {
    results = results.filter((n) => n.id === pointer.id);
  }
  if (pointer.note_type) {
    results = results.filter((n) => n.type === pointer.note_type);
  }
  if (pointer.title_prefix) {
    const prefix = pointer.title_prefix.toLowerCase();
    results = results.filter((n) => n.title.toLowerCase().startsWith(prefix));
  }
  if (pointer.provenance_tag) {
    results = results.filter((n) =>
      n.provenance_trace_ids?.some((id) => id.includes(pointer.provenance_tag!)),
    );
  }

  // Sort by updated_at descending, most recent first
  results = results
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit);

  return {
    shape: "memoryNote",
    body: { notes: results, total: results.length },
  };
}

export async function resolveMemoryNoteWrite(
  pointer: MemoryNoteWritePointer,
): Promise<ResolverResult> {
  const now = new Date().toISOString();
  const incoming = pointer.note;

  const note: MemoryNote = {
    ...incoming,
    created_at: incoming.created_at ?? now,
    updated_at: now,
  };

  const notes = await loadNotes();
  const existingIdx = notes.findIndex((n) => n.id === note.id);

  if (existingIdx >= 0) {
    // Preserve original created_at on upsert
    note.created_at = notes[existingIdx]!.created_at;
    notes[existingIdx] = note;
  } else {
    notes.push(note);
  }

  await saveNotes(notes);

  return {
    shape: "memoryNoteWriteResult",
    body: { id: note.id, action: existingIdx >= 0 ? "updated" : "created" },
  };
}
