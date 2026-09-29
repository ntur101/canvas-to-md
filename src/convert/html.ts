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
import { escapeCell } from "./table.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  linkStyle: "inlined",
});
turndown.use(gfm);

// ---------- tables ----------
//
// turndown-plugin-gfm has two gaps that mangled Canvas tables:
//   - a table whose first row isn't all <th> (Canvas's row-header layout, or a
//     <caption>) is kept as one long line of raw HTML, inline styles and all;
//   - a cell holding a list, paragraphs or a <br> puts newlines inside the row,
//     which ends the row there and spills the rest of the table as loose text.
// These rules replace its table handling. Every table becomes a Markdown table
// with its first row as the header, multi-line cell content is kept on one row
// with <br>, and colspans are padded so the columns still line up. Added after
// the plugin, so they take precedence over it (Turndown checks later rules
// first), and before the stripping rules below, which still win over them.

/** The DOM members these rules use (the project doesn't load the DOM typings). */
interface El {
  nodeName: string;
  parentNode: El | null;
  children: ArrayLike<El>;
  getAttribute(name: string): string | null;
}

/** Rows of a table, not counting those of tables nested inside its cells. */
function rowsOf(table: El): El[] {
  const rows: El[] = [];
  for (const child of Array.from(table.children) as El[]) {
    if (child.nodeName === "TR") rows.push(child);
    else if (["THEAD", "TBODY", "TFOOT"].includes(child.nodeName)) {
      for (const r of Array.from(child.children) as El[]) if (r.nodeName === "TR") rows.push(r);
    }
  }
  return rows;
}

function closestTable(node: El): El | null {
  let n = node.parentNode;
  while (n && n.nodeName !== "TABLE") n = n.parentNode;
  return n;
}

const cellsOf = (row: El): El[] => (Array.from(row.children) as El[]).filter((c) => c.nodeName === "TD" || c.nodeName === "TH");
const spanOf = (cell: El): number => Math.max(parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1, 1);
const widthOf = (row: El): number => cellsOf(row).reduce((n, c) => n + spanOf(c), 0);

turndown.addRule("tableCellAnyContent", {
  filter: ["th", "td"],
  replacement: (content, node) => {
    const cell = node as unknown as El;
    const first = cellsOf(cell.parentNode as El)[0] === cell;
    return `${first ? "| " : " "}${escapeCell(content)} |${"  |".repeat(spanOf(cell) - 1)}`;
  },
});

turndown.addRule("tableRowAnyHeader", {
  filter: "tr",
  replacement: (content, node) => {
    const row = node as unknown as El;
    const table = closestTable(row);
    const rows = table ? rowsOf(table) : [];
    if (rows[0] !== row) return `\n${content.trim()}`;
    const width = Math.max(...rows.map(widthOf), 1);
    return `\n${content.trim()}\n|${" --- |".repeat(width)}`;
  },
});

turndown.addRule("tableCaption", {
  filter: "caption",
  replacement: (content) => `\n\n${content.trim()}\n\n`,
});

turndown.addRule("tableAnyHeader", {
  filter: "table",
  replacement: (content) => `\n\n${content.trim()}\n\n`,
});

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
