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

// READ WORKSPACE_ROOT AT USE TIME, NOT AT MODULE LOAD.
//
// config.ts evaluates `WORKSPACE_ROOT` once per bun process. Importing that frozen
// const meant this resolver ignored any later WORKSPACE_ROOT — including the one the
// test sets before dynamically importing it. That idiom only works if this file is the
// FIRST to load config.ts; in a 202-file single-process `bun test` run it never is, so
// the unit test wrote to the REAL memory store under cwd instead of its tmpdir.
//
// The consequence was not a cosmetic test failure. It made the suite SELF-POISONING and
// deterministically so: run 1 creates the fixture note and asserts "created"; run 2 finds
// the note it left behind and returns "updated". feature_compose runs its baseline in a
// fresh git worktree of origin/dev where `memory/` does not exist (untracked), so the
// BASELINE PASSES and the POST-DRAFT RUN FAILS — the one failure shape the baseline-delta
// verify gate cannot subtract away. The flake re-confirmation could not save it either,
// because the state is on disk, not random: it fails again. Every feature_compose on this
// vessel since the test landed has gone UNFAVORABLE for this reason alone.
//
// It also violates law 1 directly: behaviour frozen into a module const at process start
// is invisible to traces and unlearnable. A use-time read is what the law asks for.
const notesRoot = (): string => process.env["WORKSPACE_ROOT"] ?? WORKSPACE_ROOT;
const NOTES_PATH = () => join(notesRoot(), "memory", "notes.json");

async function loadNotes(): Promise<MemoryNote[]> {
  try {
    const raw = await readFile(NOTES_PATH(), "utf-8");
    return JSON.parse(raw) as MemoryNote[];
  } catch {
    return [];
  }
}

async function saveNotes(notes: MemoryNote[]): Promise<void> {
  const dir = join(notesRoot(), "memory");
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

/**
 * Tolerant write-pointer input (2026-07-26). Accepts the canonical nested
 * envelope ({ type, note: {...} }) sent by the operator-import scripts AND a
 * flat pointer ({ type, title, content, ... }) synthesized by goal-host's
 * generic pointer-arg binding (which advertises no resolver_schema for this
 * shape and so emits flat field names). The former resolver dereferenced
 * pointer.note.created_at unconditionally and 500'd on the flat payload
 * ("undefined is not an object"), blocking composed shellResult->memoryNote_write
 * emits (topology growth). Every field is now read defensively; never throws.
 */
export interface MemoryNoteWriteInput {
  type: "memoryNote_write";
  note?: unknown;
  [key: string]: unknown;
}

const VALID_NOTE_TYPES: ReadonlyArray<MemoryNote["type"]> = [
  "finding",
  "feedback",
  "reference",
  "project",
];

function slugifyId(source: string): string {
  return source
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function resolveMemoryNoteWrite(
  pointer: MemoryNoteWriteInput,
): Promise<ResolverResult> {
  const now = new Date().toISOString();

  // A nested `note` object is the canonical envelope; anything else (absent, a
  // string from an LLM-emitted `note` key, a primitive) falls through to the
  // flat pointer. Read the fields from whichever source applies.
  const nested =
    typeof pointer.note === "object" && pointer.note !== null
      ? (pointer.note as Record<string, unknown>)
      : null;
  const src: Record<string, unknown> =
    nested ?? (pointer as Record<string, unknown>);

  const pickString = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };

  // content -> body aliasing (goal-host flat payload uses `content`).
  const title = pickString("title");
  const body = pickString("body", "content");

  // Reject cleanly — never throw — when there is nothing worth storing.
  if (title === undefined && body === undefined) {
    return {
      shape: "memoryNoteWriteResult",
      body: {
        id: null,
        action: "rejected",
        reason:
          "memoryNote_write requires at least a title or a body/content field",
      },
    };
  }

  // note_type -> type aliasing. In the flat pointer, `type` holds the shape
  // discriminant ("memoryNote_write"), so only trust it as a category when it
  // is a valid MemoryNote type (the nested-note case); otherwise fall back to
  // `note_type`, then default to "reference".
  const typeCandidate = pickString("type", "note_type");
  const noteType: MemoryNote["type"] =
    typeCandidate !== undefined &&
    (VALID_NOTE_TYPES as string[]).includes(typeCandidate)
      ? (typeCandidate as MemoryNote["type"])
      : ((): MemoryNote["type"] => {
          const nt = pickString("note_type");
          return nt !== undefined && (VALID_NOTE_TYPES as string[]).includes(nt)
            ? (nt as MemoryNote["type"])
            : "reference";
        })();

  // Preserve an explicit id; otherwise derive a stable slug from the title
  // (falling back to the body, then a timestamp so the id is never empty).
  const explicitId = pickString("id");
  const derivedSlug = slugifyId(title ?? body ?? "");
  const id =
    explicitId ??
    (derivedSlug.length > 0 ? derivedSlug : `memory-note-${Date.now()}`);

  const note: MemoryNote = {
    id,
    type: noteType,
    title: title ?? "",
    body: body ?? "",
    created_at: pickString("created_at") ?? now,
    updated_at: now,
  };

  // Preserve optional canonical fields when supplied (the nested callers send
  // some of these; the flat goal-host payload sends none).
  const prov = src["provenance_trace_ids"];
  if (Array.isArray(prov)) {
    note.provenance_trace_ids = prov.filter(
      (t): t is string => typeof t === "string",
    );
  }
  const cw = src["confidence_weight"];
  if (typeof cw === "number") note.confidence_weight = cw;
  const lva = src["last_validated_at"];
  if (typeof lva === "string") note.last_validated_at = lva;
  const ps = src["pending_sync"];
  if (typeof ps === "boolean") note.pending_sync = ps;

  const notes = await loadNotes();
  const existingIdx = notes.findIndex((n) => n.id === note.id);

  // A NOTE WITH NO CONTENT IS NOT A NOTE. The write path accepts "at least a title or a
  // body", which lets a composed walk whose content binding produced nothing still write
  // a titled shell and collect a success — the artifact exists, reads as delivered, and
  // holds nothing. Observed live: dispatch 08841a58 asked for a summary note and created
  // `llm-resolver-vessel-purpose` with body "".
  //
  // Refuse rather than accept-and-hope, so the caller's reach gate sees a failure instead
  // of a green. Refusing is also why this is not "silently keep the old body": a write
  // that carried nothing must be REPORTED, not quietly absorbed.
  const incomingBody = (body ?? "").trim();
  if (incomingBody.length === 0) {
    const existingBody = existingIdx >= 0 ? (notes[existingIdx]!.body ?? "").trim() : "";
    return {
      shape: "memoryNoteWriteResult",
      body: {
        id: note.id,
        action: "rejected",
        reason:
          existingBody.length > 0
            ? // The destructive case. `notes[existingIdx] = note` replaced the row wholesale,
              // so an empty-bodied re-write BLANKED an already-good note — a composed
              // walk's second pass could destroy the artifact its first pass earned.
              `refusing to overwrite the existing body of "${note.id}" (${existingBody.length} chars) with an empty one`
            : `refusing to create "${note.id}" with an empty body — a titled shell is not a note`,
      },
    };
  }

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
