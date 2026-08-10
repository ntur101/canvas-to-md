/**
 * Optional local overrides, merged over the defaults in config.ts.
 *
 * config.ts holds defaults that are safe for anyone who clones this: content is
 * written to a local Output/ folder and nothing is ever deleted. The settings
 * that depend on one machine — where your vault lives, whether orphan pruning is
 * allowed to delete inside it — belong in a gitignored settings.json instead, so
 * `git diff config.ts` still means something and your personal paths never get
 * committed.
 *
 * settings.json is a flat map of dotted config paths:
 *
 *   {
 *     "paths.output": "C:/Users/you/notes",
 *     "scrape.pruneOrphans": true
 *   }
 *
 * Imports nothing from the project — config.ts imports THIS, so anything pulled
 * in here would be a cycle. Hence console.warn rather than the logger.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SETTINGS_PATH = path.join(ROOT, "settings.json");

type Kind = "string" | "bool" | "stringMap";

/**
 * The whitelist of overridable settings. Deliberately not everything in
 * config.ts: timeouts and retry curves are code-shaped, and a typo in a hand
 * edited JSON file should not be able to reshape the run.
 */
const OVERRIDABLE: Record<string, Kind> = {
  "canvas.baseUrl": "string",
  "paths.output": "string",
  "scrape.subfolder": "string",
  "scrape.incremental": "bool",
  "scrape.pruneOrphans": "bool",
  "scrape.linkInternally": "bool",
  "scrape.includeRubrics": "bool",
  "scrape.includeQuizQuestions": "bool",
  "scrape.courseFolders": "stringMap",
  "extras.folder": "string",
  "extras.syllabus": "bool",
  "extras.announcements": "bool",
  "extras.unfiledPages": "bool",
  "extras.unfiledFiles": "bool",
};

/** Raw contents of settings.json, or {} when it's absent or unreadable. */
function readSettingsFile(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn("[settings] settings.json is not an object — ignoring");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`[settings] Could not read settings.json: ${(err as Error).message} — using defaults`);
    }
  }
  return {};
}

/** Validate one value against its declared kind. Returns undefined if invalid. */
function validate(dotted: string, kind: Kind, raw: unknown): unknown | undefined {
  if (kind === "bool") {
    if (typeof raw === "boolean") return raw;
    console.warn(`[settings] ${dotted}: expected true or false — using default`);
    return undefined;
  }
  if (kind === "string") {
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    console.warn(`[settings] ${dotted}: expected a non-empty string — using default`);
    return undefined;
  }
  // stringMap
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.every(([, v]) => typeof v === "string")) return Object.fromEntries(entries);
  }
  console.warn(`[settings] ${dotted}: expected an object of string values — using default`);
  return undefined;
}

function setByPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") return; // path absent in defaults
    node = next as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * Apply settings.json on top of the defaults. Only whitelisted paths are
 * honoured and every value is re-validated, so a bad entry warns and is skipped
 * rather than blowing up at import. Returns the same shape it was given.
 */
export function applyUserSettings<T>(defaults: T): T {
  const overrides = readSettingsFile();
  const entries = Object.entries(overrides);
  if (entries.length === 0) return defaults;

  // structuredClone keeps the caller's `as const` object untouched — CONFIG is
  // imported by many modules that assume it's stable.
  const merged = structuredClone(defaults) as unknown as Record<string, unknown>;

  for (const [dotted, raw] of entries) {
    const kind = OVERRIDABLE[dotted];
    if (!kind) {
      console.warn(`[settings] Unknown setting "${dotted}" — ignoring`);
      continue;
    }
    const value = validate(dotted, kind, raw);
    if (value === undefined) continue;
    setByPath(merged, dotted, value);
  }

  return merged as unknown as T;
}
