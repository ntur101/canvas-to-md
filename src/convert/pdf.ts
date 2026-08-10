/**
 * PDF → plain text, best-effort.
 *
 * Extracts the text layer of a PDF so it's searchable and readable inside
 * Obsidian. This is the lossy half: text comes through verbatim, but figures,
 * diagrams and scanned (image-only) pages don't — which is exactly why the
 * original .pdf is kept alongside. Never throws; returns null on failure so the
 * scrape continues with the original file intact.
 */

import pdfParse from "pdf-parse";
import { log } from "../logger.js";

export interface PdfText {
  text: string;
  pages: number;
}

export async function pdfToText(buffer: Buffer, label: string): Promise<PdfText | null> {
  try {
    const result = await pdfParse(buffer);
    const text = (result.text ?? "").trim();
    if (text === "") {
      log.warn(`[pdf] No extractable text in ${label} (likely scanned/image-only) — kept original only.`);
      return null;
    }
    return { text, pages: result.numpages };
  } catch (err) {
    log.warn(
      `[pdf] Text extraction failed for ${label} (kept original): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
