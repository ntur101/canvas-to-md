/**
 * HTML → Markdown, verbatim.
 *
 * Canvas Page/Assignment/Quiz bodies are HTML. Turndown converts them to
 * Markdown without dropping content; the GFM plugin adds tables and
 * strikethrough so those survive too. This is the lossless half of the scraper —
 * nothing is summarised, only reformatted.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  linkStyle: "inlined",
});
turndown.use(gfm);

// Canvas often wraps everything in <div>s with layout classes; keep the text,
// drop the empty structural noise Turndown would otherwise render as blank lines.
turndown.addRule("stripEmptyDivs", {
  filter: (node) => node.nodeName === "DIV" && node.textContent?.trim() === "",
  replacement: () => "",
});

// Canvas "Design Block" pages hide their config as JSON inside
// <span class="cdbData" style="display:none">{...}</span>. It's invisible on
// the real page but Turndown was dumping the raw JSON as text. Drop anything
// hidden (display:none) or tagged cdbData — none of it is content a student
// sees, and the visible title/text of each block renders separately.
turndown.addRule("stripHiddenDesignBlockJson", {
  filter: (node) => {
    if (!node.getAttribute) return false;
    const cls = node.getAttribute("class") ?? "";
    const style = node.getAttribute("style") ?? "";
    return /\bcdbData\b/.test(cls) || /display:\s*none/i.test(style);
  },
  replacement: () => "",
});

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html || html.trim() === "") return "";
  return turndown.turndown(html).trim();
}
