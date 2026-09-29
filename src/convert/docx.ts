/**
 * DOCX -> Markdown, verbatim.
 *
 * A .docx is a zip of XML: the body lives in word/document.xml as <w:p>
 * paragraphs of <w:t> text runs and <w:tbl> tables. Heading paragraphs carry a
 * <w:pStyle w:val="Heading2"/>, so those become Markdown headings and the
 * document keeps its shape. Tables become Markdown tables: a cell's paragraphs
 * are kept apart with <br>, a cell merged across columns (gridSpan) is padded so
 * the columns still line up, and a cell merged down rows (vMerge) keeps its
 * text in the top row only. A table nested inside a cell is flattened into that
 * cell's text. The original .docx is kept alongside for exact layout. Never
 * throws; returns null on failure.
 *
 * This exists because SharePoint sharing links use a `:w:` token for Word docs,
 * so they were being downloaded and then left unconverted with a "no text could
 * be extracted" pointer note.
 */

import AdmZip from "adm-zip";
import { log } from "../logger.js";
import { markdownTable } from "./table.js";
import { children, decodeXml, inner } from "./xml.js";

export interface DocxText {
  text: string;
  paragraphs: number;
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

/** The cell's own properties block, not a nested table's. */
function cellProps(cellXml: string): string {
  return children(inner(cellXml), ["w:tcPr"])[0]?.xml ?? "";
}

/** All text in a cell, one line per paragraph; nested tables are flattened the same way. */
function cellText(cellXml: string): string {
  const lines: string[] = [];
  for (const el of children(inner(cellXml), ["w:p", "w:tbl"])) {
    if (el.tag === "w:p") {
      const text = paragraphText(el.xml);
      if (text !== "") lines.push(text);
    } else {
      for (const row of children(inner(el.xml), ["w:tr"])) {
        const cells = children(inner(row.xml), ["w:tc"]).map((c) => cellText(c.xml).replace(/\n/g, " ")).filter(Boolean);
        if (cells.length > 0) lines.push(cells.join(" | "));
      }
    }
  }
  return lines.join("\n");
}

/** A <w:tbl> as a Markdown table, and how many paragraphs of text it held. */
function tableMarkdown(tableXml: string): { md: string; paragraphs: number } {
  const rows: string[][] = [];
  let paragraphs = 0;
  for (const row of children(inner(tableXml), ["w:tr"])) {
    const cells: string[] = [];
    for (const cell of children(inner(row.xml), ["w:tc"])) {
      const props = cellProps(cell.xml);
      const span = parseInt(props.match(/<w:gridSpan\b[^>]*w:val="(\d+)"/)?.[1] ?? "1", 10);
      // <w:vMerge/> without val="restart" continues the cell above; its text is there.
      const continued = /<w:vMerge\b(?![^>]*w:val="restart")[^>]*\/?>/.test(props);
      const text = continued ? "" : cellText(cell.xml);
      if (text !== "") paragraphs += text.split("\n").length;
      cells.push(text, ...Array<string>(Math.max(span - 1, 0)).fill(""));
    }
    rows.push(cells);
  }
  return { md: markdownTable(rows), paragraphs };
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
    const body = children(xml, ["w:body"])[0];
    const blocks = children(body ? inner(body.xml) : xml, ["w:p", "w:tbl"]);

    const parts: string[] = [];
    let kept = 0;
    for (const el of blocks) {
      if (el.tag === "w:tbl") {
        const table = tableMarkdown(el.xml);
        if (table.md === "") continue;
        kept += table.paragraphs;
        parts.push(table.md);
        continue;
      }
      const text = paragraphText(el.xml);
      if (text === "") continue;
      kept += 1;
      const level = headingLevel(el.xml);
      // Offset by one: the note already opens with an H1 for the file itself.
      parts.push(level > 0 ? `${"#".repeat(Math.min(level + 1, 6))} ${text}` : text);
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
