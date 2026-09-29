/**
 * XLSX -> Markdown tables, verbatim.
 *
 * Each worksheet becomes a Markdown table under an H2 of its sheet name. Cell
 * values come through as-is (numbers, text, dates as SheetJS formats them). No
 * formulas or styling — the original .xlsx is kept alongside. Never throws.
 */

import * as XLSX from "xlsx";
import { log } from "../logger.js";
import { markdownTable } from "./table.js";

export interface XlsxText {
  text: string;
  sheets: number;
}

// SheetJS can hand back smart quotes/dashes as Mac-Roman-mangled UTF-8 — e.g.
// "‚Äô" where the document had a curly apostrophe (U+2019). Repair the common
// sequences so cells read as they did in the spreadsheet. These 2–3 char
// sequences never occur in legitimate text, so the replacement is safe.
const MOJIBAKE: Array<[string, string]> = [
  ["‚Äô", "’"], // '  right single quote
  ["‚Äò", "‘"], // '  left single quote
  ["‚Äú", "“"], // "  left double quote
  ["‚Äù", "”"], // "  right double quote
  ["‚Äì", "–"], // –  en dash
  ["‚Äî", "—"], // —  em dash
  ["‚Ä¶", "…"], // …  ellipsis
  ["‚Ä¢", "•"], // •  bullet
  ["¬†", " "],       //    non-breaking space
];

function fixMojibake(s: string): string {
  let out = s;
  for (const [bad, good] of MOJIBAKE) out = out.split(bad).join(good);
  return out;
}

/** A 2-D array of rows -> a GitHub Markdown table (first row as the header). */
function rowsToTable(rows: unknown[][]): string {
  const table = markdownTable(rows.map((r) => r.map((c) => fixMojibake(String(c ?? "")))));
  return table === "" ? "_(empty sheet)_" : table;
}

export function xlsxToMarkdown(buffer: Buffer, label: string): XlsxText | null {
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
      parts.push(`## ${name}\n\n${rowsToTable(rows)}`);
    }
    const text = parts.join("\n\n").trim();
    if (text === "") return null;
    return { text, sheets: wb.SheetNames.length };
  } catch (err) {
    log.warn(`[xlsx] Conversion failed for ${label} (kept original): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
