/**
 * DOCX -> Markdown, verbatim.
 *
 * A .docx is a zip of XML: the body lives in word/document.xml as <w:p>
 * paragraphs of <w:t> text runs. Heading paragraphs carry a <w:pStyle
 * w:val="Heading2"/>, so those become Markdown headings and the document keeps
 * its shape. Table cell text comes through as ordinary paragraphs (cells are
 * <w:p> too) rather than as Markdown tables — the original .docx is kept
 * alongside for exact layout. Never throws; returns null on failure.
 *
 * This exists because SharePoint sharing links use a `:w:` token for Word docs,
 * so they were being downloaded and then left unconverted with a "no text could
 * be extracted" pointer note.
 */

import AdmZip from "adm-zip";
import { log } from "../logger.js";

export interface DocxText {
  text: string;
  paragraphs: number;
}

/** Decode the handful of XML entities that appear in <w:t> runs. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Heading depth from <w:pStyle w:val="Heading3"/>, or 0 for body text. */
function headingLevel(paragraphXml: string): number {
  const m = paragraphXml.match(/<w:pStyle[^>]*w:val="Heading(\d)"/i);
  return m ? parseInt(m[1], 10) : 0;
}

/** Text of every <w:t> run in a paragraph, with <w:br/> as a line break. */
function paragraphText(paragraphXml: string): string {
  const withBreaks = paragraphXml.replace(/<w:br\b[^>]*\/>/g, "\n");
  const runs = [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
  return runs.join("").replace(/[ \t]+/g, " ").trim();
}

export function docxToMarkdown(buffer: Buffer, label: string): DocxText | null {
  try {
    const zip = new AdmZip(buffer);
    const doc = zip.getEntry("word/document.xml");
    if (!doc) {
      log.warn(`[docx] No word/document.xml in ${label} — kept original only.`);
      return null;
    }

    const xml = doc.getData().toString("utf-8");
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)];

    const parts: string[] = [];
    let kept = 0;
    for (const [full] of paragraphs) {
      const body = paragraphText(full);
      if (body === "") continue;
      kept += 1;
      const level = headingLevel(full);
      // Offset by one: the note already opens with an H1 for the file itself.
      parts.push(level > 0 ? `${"#".repeat(Math.min(level + 1, 6))} ${body}` : body);
    }

    if (kept === 0) {
      log.warn(`[docx] No text found in ${label} — kept original only.`);
      return null;
    }
    return { text: parts.join("\n\n").trim(), paragraphs: kept };
  } catch (err) {
    log.warn(`[docx] Extraction failed for ${label} (kept original): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
