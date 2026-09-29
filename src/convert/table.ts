/**
 * Shared Markdown table rendering for every converter that recovers a table
 * (pdf, docx, pptx, xlsx), so they all escape and pad cells the same way.
 *
 * GitHub-flavoured Markdown tables are one line per row, so anything that would
 * break a row is neutralised here: a literal `|` is escaped, and line breaks
 * inside a cell become `<br>` (Obsidian renders it inside a table cell). The
 * first row is always used as the header row, because GFM requires one and the
 * source formats don't reliably say which row is the header.
 */

/** One cell's text, made safe to sit inside a single Markdown table row. */
export function escapeCell(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("<br>")
    .replace(/(?<!\\)\|/g, "\\|");
}

/**
 * Rows of cell text -> a GitHub Markdown table. Empty rows are dropped, short
 * rows are padded to the widest row, and cells go through escapeCell. Returns
 * "" when there's nothing to show so callers can skip the block entirely.
 */
export function markdownTable(rows: string[][]): string {
  const cleaned = rows.map((r) => r.map(escapeCell)).filter((r) => r.some((c) => c !== ""));
  if (cleaned.length === 0) return "";

  const width = Math.max(...cleaned.map((r) => r.length));
  const pad = (r: string[]): string[] => [...r, ...Array<string>(width - r.length).fill("")];

  const [header, ...body] = cleaned.map(pad);
  return [header, header.map(() => "---"), ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
}
