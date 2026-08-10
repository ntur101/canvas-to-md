/**
 * Downloaded file bytes -> extracted Markdown, keyed on extension.
 *
 * Shared by Canvas files, SharePoint downloads and the unfiled-files sweep so
 * every path converts the same types the same way. Returns null when the type
 * has no converter or the file yields no text — the caller then keeps the
 * original with a pointer note.
 */

import { log } from "./logger.js";
import { pdfToText } from "./convert/pdf.js";
import { pptxToText } from "./convert/pptx.js";
import { xlsxToMarkdown } from "./convert/xlsx.js";
import { docxToMarkdown } from "./convert/docx.js";
import { cleanExtractedText, countNoise } from "./convert/text.js";

export interface Extraction {
  text: string;
  note: string;
  extra: Record<string, string>;
}

export async function extractFileMarkdown(
  ext: string,
  buffer: Buffer,
  label: string,
  originalName: string,
): Promise<Extraction | null> {
  let extraction: Extraction | null = null;

  if (ext === "pdf") {
    const r = await pdfToText(buffer, label);
    if (r) extraction = { text: r.text, note: `Extracted text from \`${originalName}\` (${r.pages} pages). Figures/diagrams are in the original.`, extra: { pages: String(r.pages) } };
  } else if (ext === "pptx") {
    const r = pptxToText(buffer, label);
    if (r) extraction = { text: r.text, note: `Slide text extracted from \`${originalName}\` (${r.slides} slides). Images/layout are in the original.`, extra: { slides: String(r.slides) } };
  } else if (ext === "xlsx") {
    const r = xlsxToMarkdown(buffer, label);
    if (r) extraction = { text: r.text, note: `Sheets from \`${originalName}\` (${r.sheets} sheet(s)) as tables.`, extra: { sheets: String(r.sheets) } };
  } else if (ext === "docx") {
    const r = docxToMarkdown(buffer, label);
    if (r) extraction = { text: r.text, note: `Text extracted from \`${originalName}\` (${r.paragraphs} paragraphs). Exact layout is in the original.`, extra: { paragraphs: String(r.paragraphs) } };
  }

  if (!extraction) return null;

  // Every converter goes through the same cleanup: some PDFs come back with NUL
  // bytes woven through the text, which would otherwise land in the vault as
  // unsearchable binary-flagged noise.
  const noise = countNoise(extraction.text);
  if (noise > 0) log.warn(`[extract] Stripped ${noise} control character(s) from ${label}.`);

  const text = cleanExtractedText(extraction.text);
  return text === "" ? null : { ...extraction, text };
}
