/**
 * PPTX -> text, verbatim.
 *
 * A .pptx is a zip of XML. Each slide's text lives in ppt/slides/slideN.xml as
 * <a:t> runs; speaker notes live in ppt/notesSlides/notesSlideN.xml. We pull
 * both, per slide, in slide order. No layout or images — the original .pptx is
 * kept alongside for those. Never throws; returns null on failure.
 */

import AdmZip from "adm-zip";
import { log } from "../logger.js";

export interface PptxText {
  text: string;
  slides: number;
}

/** Decode the handful of XML entities that appear in <a:t> runs. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Concatenated text of every <a:t> run in an XML string, space-joined. */
function textRuns(xml: string): string {
  const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
  return runs.join(" ").replace(/\s+/g, " ").trim();
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
      const body = textRuns(slide.getData().toString("utf-8"));
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
