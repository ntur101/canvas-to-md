/**
 * Cleanup applied to every piece of extracted text before it's written.
 *
 * The motivating case: pdf-parse hands back NUL bytes interleaved through the
 * text of some PDFs (PowerPoint exports are the usual culprit — it reads like a
 * UTF-16 run decoded a byte at a time). One deck came out 77% NUL bytes, which
 * makes the note unsearchable, flags it as binary to tooling, and feeds junk to
 * anything reading the vault for context. The visible text is intact underneath,
 * so stripping the control characters recovers it exactly — nothing readable is
 * lost, which keeps the verbatim guarantee.
 *
 * Tested by char code rather than a regex character class: literal control
 * characters do not survive being written into a regex in this codebase (the
 * same reason src/scrape.ts builds its illegal-filename set by hand).
 */

const TAB = 9;
const NEWLINE = 10;
const FORM_FEED = 12;
const DEL = 127;
const BOM = 0xfeff;

/** Control-character noise: not text, not one of the whitespace chars we keep. */
function isNoise(code: number): boolean {
  if (code === TAB || code === NEWLINE) return false;
  return code < 32 || code === DEL || code === BOM;
}

/** Strip control-character noise and normalise line endings. */
export function cleanExtractedText(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    // A form feed is a page break in extracted PDF text — keep it as a line
    // break rather than silently welding two pages together.
    if (code === FORM_FEED) {
      out += "\n";
      continue;
    }
    if (isNoise(code)) continue;
    out += ch;
  }
  // Collapse the runs of blank lines the above can leave behind.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Just the noise removal from cleanExtractedText, with no other changes: for a
 * fragment of text (one PDF text item) whose spacing still matters.
 */
export function stripNoise(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!isNoise(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/** How many characters cleaning would strip — for logging a noisy extraction. */
export function countNoise(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (isNoise(ch.codePointAt(0) ?? 0)) n += 1;
  }
  return n;
}
