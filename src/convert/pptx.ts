/**
 * PPTX -> text, verbatim.
 *
 * A .pptx is a zip of XML. Each slide's text lives in ppt/slides/slideN.xml as
 * <a:t> runs; speaker notes live in ppt/notesSlides/notesSlideN.xml. We pull
 * both, per slide, in slide order. A table on a slide (<a:tbl>) becomes a
 * Markdown table in place, rather than its cells running into the slide text;
 * a merged cell keeps its text in its top-left position. No layout or images —
 * the original .pptx is kept alongside for those. Never throws; returns null
 * on failure.
 */

import AdmZip from "adm-zip";
import { log } from "../logger.js";
import { markdownTable } from "./table.js";
import { children, decodeXml, inner } from "./xml.js";

export interface PptxText {
  text: string;
  slides: number;
}

/** Concatenated text of every <a:t> run in an XML string, space-joined. */
function textRuns(xml: string): string {
  const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
  return runs.join(" ").replace(/\s+/g, " ").trim();
}

/** One table cell's text: runs joined within a paragraph, paragraphs on their own lines. */
function cellText(cellXml: string): string {
  return children(inner(cellXml), ["a:p"])
    .map((p) => [...p.xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("").trim())
    .filter((t) => t !== "")
    .join("\n");
}

/**
 * An <a:tbl> as a Markdown table. PowerPoint writes one <a:tc> per grid cell
 * even under a merge, flagging the covered ones with hMerge/vMerge, so the
 * columns already line up and only the covered cells need blanking.
 */
function tableMarkdown(tableXml: string): string {
  const rows = children(inner(tableXml), ["a:tr"]).map((row) =>
    children(inner(row.xml), ["a:tc"]).map((cell) => {
      const open = cell.xml.slice(0, cell.xml.indexOf(">") + 1);
      return /\b[hv]Merge="(1|true)"/.test(open) ? "" : cellText(cell.xml);
    }),
  );
  return markdownTable(rows);
}

/** A slide's text with each table rendered in place as a Markdown table. */
function slideBody(xml: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const table of children(xml, ["a:tbl"])) {
    const before = textRuns(xml.slice(last, table.start));
    if (before) parts.push(before);
    const md = tableMarkdown(table.xml);
    if (md) parts.push(md);
    last = table.start + table.xml.length;
  }
  const rest = textRuns(xml.slice(last));
  if (rest) parts.push(rest);
  return parts.join("\n\n");
}

/** Numeric index in "slide12.xml" -> 12, for correct ordering. */
function slideIndex(name: string): number {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

export function pptxToText(buffer: Buffer, label: string): PptxText | null {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    const slides = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => slideIndex(a.entryName) - slideIndex(b.entryName));

    if (slides.length === 0) {
      log.warn(`[pptx] No slides found in ${label} — kept original only.`);
      return null;
    }

    const notesByIndex = new Map<number, string>();
    for (const e of entries) {
      const m = e.entryName.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
      if (m) notesByIndex.set(parseInt(m[1], 10), textRuns(e.getData().toString("utf-8")));
    }

    const parts: string[] = [];
    slides.forEach((slide, i) => {
      const n = i + 1;
      const body = slideBody(slide.getData().toString("utf-8"));
      parts.push(`## Slide ${n}\n\n${body || "_(no text on this slide)_"}`);
      const notes = notesByIndex.get(slideIndex(slide.entryName));
      if (notes) parts.push(`**Speaker notes:** ${notes}`);
    });

    const text = parts.join("\n\n").trim();
    if (text === "") return null;
    return { text, slides: slides.length };
  } catch (err) {
    log.warn(`[pptx] Extraction failed for ${label} (kept original): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
