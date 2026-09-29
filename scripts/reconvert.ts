/**
 * npm run reconvert — re-run the file converters over originals already on disk.
 *
 * A scrape only converts a file when it downloads it, and most downloads never
 * repeat: linked and unfiled files are existence-based even under --force, and
 * SharePoint decks are too. So when a converter improves, the notes already in
 * the vault keep the old output. This fixes that offline, with no Canvas or
 * SharePoint session: for every "<original>.md" note next to its original under
 * a course's module or Course Info folder, it re-extracts the original and swaps
 * in the new text.
 *
 * Only the extracted body changes, plus the counts in the frontmatter and the
 * blurb line that the extraction itself produced; the title, the rest of the
 * frontmatter and the blurb's own wording are kept. A note is only touched when
 * its frontmatter says it was generated from that exact file (`source_file`),
 * so nothing hand-written is ever overwritten.
 *
 * Flags:
 *   --dry-run   report what would change without writing anything
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { extractFileMarkdown } from "../src/extract.js";
import { log } from "../src/logger.js";
import { escapeYaml, extOf } from "../src/notes.js";

const CONVERTIBLE = new Set(["pdf", "pptx", "xlsx", "docx"]);
/** The note text each converter's blurb ends with (see src/extract.ts). */
const EXTRACTION_NOTE = /(Extracted text from|Slide text extracted from|Sheets from|Text extracted from) `.*$/;

const dryRun = process.argv.includes("--dry-run");

/** Every "<original>.md" note under a folder, paired with its original. */
function* notePairs(dir: string): Generator<{ original: string; note: string }> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* notePairs(full);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const original = full.slice(0, -3);
    if (CONVERTIBLE.has(extOf(original)) && fs.existsSync(original)) yield { original, note: full };
  }
}

/** Frontmatter, heading + blurb, and body of a generated file note, or null if it isn't one. */
function splitNote(content: string): { front: string; head: string; blurb: string; body: string } | null {
  const m = content.match(/^(---\n[\s\S]*?\n---\n)(# [^\n]*\n\n)(> [^\n]*)\n\n([\s\S]*)$/);
  return m ? { front: m[1], head: m[2], blurb: m[3], body: m[4] } : null;
}

async function main(): Promise<void> {
  const root = CONFIG.paths.output;
  const tally = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

  for (const course of fs.readdirSync(root, { withFileTypes: true })) {
    if (!course.isDirectory()) continue;
    for (const sub of [CONFIG.scrape.subfolder, CONFIG.extras.folder]) {
      for (const { original, note } of notePairs(path.join(root, course.name, sub))) {
        const rel = path.relative(root, note);
        const content = fs.readFileSync(note, "utf-8").replace(/\r\n/g, "\n");
        const parts = splitNote(content);
        const name = path.basename(original);
        if (!parts || !parts.front.includes(`\nsource_file: "${escapeYaml(name)}"\n`) || !EXTRACTION_NOTE.test(parts.blurb)) {
          // Not a note this tool extracted from that file (e.g. a "no text" pointer note).
          tally.skipped += 1;
          continue;
        }

        const extracted = await extractFileMarkdown(extOf(original), fs.readFileSync(original), rel, name);
        if (!extracted) {
          log.warn(`[reconvert] No text from ${rel} this time; left the existing note alone.`);
          tally.failed += 1;
          continue;
        }

        let front = parts.front;
        for (const [key, value] of Object.entries(extracted.extra)) {
          front = front.replace(new RegExp(`\\n${key}: "[^\\n]*"\\n`), `\n${key}: "${escapeYaml(value)}"\n`);
        }
        const blurb = parts.blurb.replace(EXTRACTION_NOTE, extracted.note);
        const next = `${front}${parts.head}${blurb}\n\n${extracted.text}\n`;

        if (next === content) {
          tally.unchanged += 1;
          continue;
        }
        tally.updated += 1;
        log.info(`[reconvert] ${dryRun ? "Would update" : "Updated"} ${rel}`);
        if (!dryRun) fs.writeFileSync(note, next, "utf-8");
      }
    }
  }

  log.info(
    `[reconvert] ${dryRun ? "Dry run: " : ""}${tally.updated} ${dryRun ? "would change" : "updated"}, ` +
      `${tally.unchanged} unchanged, ${tally.skipped} skipped (not an extracted note), ${tally.failed} failed.`,
  );
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
