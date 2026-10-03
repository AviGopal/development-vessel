/**
 * NON-PRINTING BYTES IN A GROUNDING WINDOW — scaffold for the check-first commit (the
 * behavior lands in the next commit): every function here is the pre-fix pass-through.
 */
export const CONTROL_BYTE_LEGEND = "";
export function renderControlBytes(text: string): { text: string; escaped: number } { return { text, escaped: 0 }; }
export function renderWindowForDrafter(text: string): string { return text; }
export function decodeControlByteEscapes(anchor: string): string { return anchor; }
export type BoundAnchor =
  | { anchor: string; via: "literal" | "decoded" }
  | { refused: "ambiguous_control_byte_anchor"; detail: string };
export function bindDraftedAnchor(_content: string, anchor: string): BoundAnchor { return { anchor, via: "literal" }; }
export function lineMatchesDrafted(fileLine: string | undefined, drafted: string | undefined): boolean {
  return typeof fileLine === "string" && fileLine === drafted;
}
