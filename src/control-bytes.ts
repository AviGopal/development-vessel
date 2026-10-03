/**
 * NON-PRINTING BYTES IN A GROUNDING WINDOW (gap
 * grounding-windows-render-control-bytes-invisibly-so-the-drafter-cannot-anchor-on-them).
 *
 * A source file can hold a raw control byte where an escape was meant (a raw 0x08 inside a
 * regex literal where `\b` was written). Shown raw in the drafter's window the byte is
 * invisible, so the drafter cannot quote it: it writes `\b` (anchor_not_found) or returns no
 * ops at all, and that whole gap family can never land.
 *
 * RENDERING. Every window shown to the drafter renders C0 controls (except TAB and LF), DEL and
 * C1 controls as a visible four-character escape `\xNN`, and carries a one-line legend ONLY when
 * at least one byte was escaped. Printable-only text is returned unchanged, byte for byte.
 *
 * ANCHOR BINDING. A drafted anchor (old_string / expected boundary line) may quote the rendered
 * form. It is bound to the file like this:
 *   1. decode only `\xNN` whose byte is in the rendered class (`\x41` is never decoded);
 *      if nothing decodes, the anchor is used literally, unchanged;
 *   2. count the LITERAL occurrences L and the DECODED occurrences D in the file;
 *   3. L > 0 and D > 0  → REFUSED (ambiguous_control_byte_anchor): the anchor names two
 *      different places and neither reading may be guessed;
 *      L > 0           → the literal anchor (a real backslash-x sequence in source still binds);
 *      D > 0           → the decoded anchor (raw bytes);
 *      neither         → the literal anchor, so the existing anchor_not_found path reports it.
 *
 * REPLACEMENT TEXT IS NEVER DECODED. A new_string containing `\x08` is ambiguous (the raw byte,
 * or the text?), and the usual intent of an edit over such a line is to REPLACE the control byte
 * with a proper source escape such as `\b`. So new_string is written literally; the legend says so.
 */

const CONTROL_CLASS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const isControlCode = (code: number): boolean =>
  (code <= 0x08) || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);

/** The legend appended to a window in which at least one byte was escaped. One line. */
export const CONTROL_BYTE_LEGEND =
  "(LEGEND: \\xNN in this window is ONE non-printing byte shown visibly, e.g. \\x08 is the raw byte 0x08; an old_string may quote it as \\xNN (in JSON: \\\\xNN) and it binds to the raw byte; new_string is written LITERALLY, so to replace such a byte write the source escape you mean, e.g. \\b in a regex)";

/** Render non-printing bytes as `\xNN`. Returns the rendered text and how many bytes were escaped. */
export function renderControlBytes(text: string): { text: string; escaped: number } {
  let escaped = 0;
  const out = text.replace(CONTROL_CLASS, (ch) => {
    escaped++;
    return `\\x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  });
  return { text: escaped > 0 ? out : text, escaped };
}

/** Render a window for the drafter: escapes plus the legend line, only when something was escaped. */
export function renderWindowForDrafter(text: string): string {
  const r = renderControlBytes(text);
  return r.escaped > 0 ? `${r.text}\n${CONTROL_BYTE_LEGEND}` : text;
}

/** Decode `\xNN` escapes whose byte is in the rendered class; every other sequence is left as written. */
export function decodeControlByteEscapes(anchor: string): string {
  return anchor.replace(/\\x([0-9A-Fa-f]{2})/g, (m, hex: string) => {
    const code = parseInt(hex, 16);
    return isControlCode(code) ? String.fromCharCode(code) : m;
  });
}

export type BoundAnchor =
  | { anchor: string; via: "literal" | "decoded" }
  | { refused: "ambiguous_control_byte_anchor"; detail: string };

const count = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);

/** Bind a drafted anchor to the file it edits (the rule is in the module comment). */
export function bindDraftedAnchor(content: string, anchor: string): BoundAnchor {
  const decoded = decodeControlByteEscapes(anchor);
  if (decoded === anchor) return { anchor, via: "literal" };
  const literalHits = count(content, anchor);
  const decodedHits = count(content, decoded);
  if (literalHits > 0 && decodedHits > 0) {
    return {
      refused: "ambiguous_control_byte_anchor",
      detail: `ambiguous_control_byte_anchor: the anchor matches literally (${literalHits}x, a backslash-x sequence in source) AND with its \\xNN escapes decoded to raw bytes (${decodedHits}x) — refusing to guess which place is meant; quote more context`,
    };
  }
  if (literalHits > 0) return { anchor, via: "literal" };
  if (decodedHits > 0) return { anchor: decoded, via: "decoded" };
  return { anchor, via: "literal" };
}

/** A file line equals a drafted boundary line when it matches literally or in its rendered form. */
export function lineMatchesDrafted(fileLine: string | undefined, drafted: string | undefined): boolean {
  if (typeof fileLine !== "string" || typeof drafted !== "string") return false;
  return fileLine === drafted || renderControlBytes(fileLine).text === drafted;
}
