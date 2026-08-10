/**
 * Shared note-writing helpers: filename sanitising, YAML frontmatter, and the
 * small path utilities. Split out of src/scrape.ts so the module walk and the
 * outside-the-modules extras (src/extras.ts) build notes the same way.
 */

import fs from "node:fs";
import path from "node:path";

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Characters not allowed in Windows/most filenames. Built from char codes to
// avoid embedding a regex character-class (which kept getting mangled on write).
const ILLEGAL_FILENAME_CHARS = new Set([
  "<", ">", ":", '"', "/", "\\", "|", "?", "*",
]);

/** Strip illegal + control characters and clamp length (spaces/hyphens kept). */
export function sanitize(name: string | undefined): string {
  const cleaned = [...(name ?? "")]
    .filter((ch) => !ILLEGAL_FILENAME_CHARS.has(ch) && ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned || "untitled";
}

export function escapeYaml(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

export function frontmatter(fields: Record<string, string | undefined>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === "") continue;
    lines.push(`${k}: "${escapeYaml(v)}"`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function writeText(dest: string, content: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf-8");
}

export function extOf(name: string | undefined): string {
  const m = (name ?? "").match(/\.([a-z0-9]{1,6})$/i);
  return m ? m[1].toLowerCase() : "";
}

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Today, as the `scraped:` frontmatter stamp. Stable for a whole run. */
export const NOW = new Date().toISOString().slice(0, 10);
