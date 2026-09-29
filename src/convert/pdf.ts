/**
 * PDF → Markdown text, best-effort.
 *
 * Extracts the text layer of a PDF so it's searchable and readable inside
 * Obsidian. This is the lossy half: text comes through verbatim, but figures,
 * diagrams and scanned (image-only) pages don't — which is exactly why the
 * original .pdf is kept alongside. Never throws; returns null on failure so the
 * scrape continues with the original file intact.
 *
 * Uses pdf.js directly (pdfjs-dist) rather than pdf-parse. pdf-parse bundled a
 * 2017 pdf.js and threw away every item's horizontal position, so tables came
 * out one cell per line in whatever order the PDF stored them, and some bullet
 * glyphs came out as U+FFFD. Now:
 *   - bordered tables are rebuilt as Markdown tables (src/convert/pdfLayout.ts),
 *     including tables that run over a page break;
 *   - everything else keeps pdf-parse's content-stream line order, with spaces
 *     restored between items that are visibly apart;
 *   - words broken by ligature glyphs are repaired (src/convert/ligatures.ts).
 */

import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { log } from "../logger.js";
import { repairLigatures } from "./ligatures.js";
import { continues, findTables, streamLines, tableRows, type OperatorList, type Table, type TextItem } from "./pdfLayout.js";
import { markdownTable } from "./table.js";
import { stripNoise } from "./text.js";

export interface PdfText {
  text: string;
  pages: number;
}

/** `merged`: this page's copy of a table folded into the previous page's; renders nothing. */
type Block = { kind: "text"; lines: string[] } | { kind: "table"; table: Table; merged?: boolean };

/**
 * Lines of text before a continued table on its new page, or after it on the
 * old one, that still count as "nothing in between": the page header/footer.
 */
const MAX_FURNITURE_LINES = 3;

/** How far each page box is widened, in points, before text extraction (see below). */
const PAGE_MARGIN = 72;

/**
 * A copy of the PDF with every page box widened by PAGE_MARGIN on each side.
 *
 * pdf.js drops any text whose starting point lies outside the page box, even
 * when the letters themselves are on the page: slide text whose baseline sits a
 * point below the bottom edge vanished completely (a PowerPoint export of an
 * ENGGEN 403 guest lecture lost a whole line that way). There's no option to
 * turn that off, so the boxes are widened instead. Text positions don't move,
 * so table detection is unaffected. Falls back to the original bytes whenever
 * pdf-lib can't rewrite the file (encrypted or malformed PDFs).
 */
async function widenPageBoxes(buffer: Buffer): Promise<Uint8Array> {
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
    for (const page of pdf.getPages()) {
      const { x, y, width, height } = page.getMediaBox();
      const box = [x - PAGE_MARGIN, y - PAGE_MARGIN, width + 2 * PAGE_MARGIN, height + 2 * PAGE_MARGIN] as const;
      page.setMediaBox(...box);
      page.setCropBox(...box);
    }
    return await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
  } catch {
    return new Uint8Array(buffer);
  }
}

/** One page as running text interleaved with tables, in content-stream order. */
function pageBlocks(items: TextItem[], owner: Map<TextItem, Table>): Block[] {
  const blocks: Block[] = [];
  const placed = new Set<Table>();
  let run: TextItem[] = [];
  const flush = (): void => {
    const lines = streamLines(run);
    if (lines.length > 0) blocks.push({ kind: "text", lines });
    run = [];
  };
  for (const item of items) {
    const table = owner.get(item);
    if (!table) run.push(item);
    else if (!placed.has(table)) {
      flush();
      blocks.push({ kind: "table", table });
      placed.add(table);
    }
  }
  flush();
  return blocks;
}

const linesBetween = (blocks: Block[], from: number, to: number): number =>
  blocks.slice(from, to).reduce((n, b) => n + (b.kind === "text" ? b.lines.length : 0), 0);

/**
 * Fold each page's first table into the previous page's last table when it's
 * the same table carrying on. The folded block is dropped; its cells now live
 * in the earlier table, which renders them all under the one header row.
 */
function joinContinuedTables(pages: Block[][]): void {
  for (let p = 1; p < pages.length; p++) {
    const prevBlocks = pages[p - 1];
    const blocks = pages[p];
    const prevIdx = prevBlocks.map((b) => b.kind).lastIndexOf("table");
    const nextIdx = blocks.findIndex((b) => b.kind === "table");
    if (prevIdx < 0 || nextIdx < 0) continue;

    const prevBlock = prevBlocks[prevIdx];
    const nextBlock = blocks[nextIdx];
    if (prevBlock.kind !== "table" || nextBlock.kind !== "table") continue;
    const prev = prevBlock.table;
    const next = nextBlock.table;
    if (linesBetween(prevBlocks, prevIdx + 1, prevBlocks.length) > MAX_FURNITURE_LINES) continue;
    if (linesBetween(blocks, 0, nextIdx) > MAX_FURNITURE_LINES) continue;
    if (!continues(prev, next)) continue;

    prev.cells.push(...next.cells);
    // Point at the merged table, so a third page can carry on the same one.
    blocks[nextIdx] = { kind: "table", table: prev, merged: true };
  }
}

function renderTable(table: Table): string {
  const all = tableRows(table);
  // Word repeats a table's header row on each new page; show it once.
  const header = all[0]?.join("\u0000");
  const rows = all.filter((r, i) => i === 0 || r.join("\u0000") !== header);
  // A single framed box, or a row or column of boxes, is a slide diagram rather
  // than a table: keep its text as plain lines instead of a one-cell-wide grid.
  if (rows.length < 2 || Math.max(...rows.map((r) => r.filter(Boolean).length)) < 2) {
    return rows.flat().filter(Boolean).join("\n");
  }
  return markdownTable(rows);
}

function renderPage(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") parts.push(b.lines.join("\n"));
    else if (!b.merged) {
      const md = renderTable(b.table);
      if (md !== "") parts.push(`\n${md}\n`);
    }
  }
  return parts.join("\n").trim();
}

export async function pdfToText(buffer: Buffer, label: string): Promise<PdfText | null> {
  let doc: Awaited<ReturnType<typeof getDocument>["promise"]> | null = null;
  try {
    doc = await getDocument({
      data: await widenPageBoxes(buffer),
      verbosity: 0,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;

    const pages: Block[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = content.items.filter((i): i is typeof i & TextItem => "str" in i);
      // Strip NUL-style noise up front (see text.ts), so a box holding only
      // noise reads as empty rather than becoming a table of blank cells.
      for (const item of items) item.str = stripNoise(item.str);
      const ops = (await page.getOperatorList()) as unknown as OperatorList;
      const { owner } = findTables(ops, items, n);
      pages.push(pageBlocks(items, owner));
      page.cleanup();
    }
    joinContinuedTables(pages);

    const raw = pages.map(renderPage).filter((p) => p !== "").join("\n\n").trim();
    if (raw === "") {
      log.warn(`[pdf] No extractable text in ${label} (likely scanned/image-only) — kept original only.`);
      return null;
    }

    const repaired = repairLigatures(raw);
    if (repaired.marked + repaired.doubled > 0) {
      log.info(`[pdf] Repaired ${repaired.marked + repaired.doubled} ligature-broken word(s) in ${label}.`);
    }
    return { text: repaired.text, pages: doc.numPages };
  } catch (err) {
    log.warn(
      `[pdf] Text extraction failed for ${label} (kept original): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    await doc?.destroy().catch(() => undefined);
  }
}
