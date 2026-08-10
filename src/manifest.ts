/**
 * Local cache of each module item's last-seen Canvas `updated_at`, so repeat
 * scrapes can skip re-downloading/re-converting anything unchanged. Keyed by
 * the module item's own id (stable across reorders/renames within a course),
 * not by output path, so a renamed item still gets picked up as changed.
 *
 * Lives in the repo (state/manifest.json), not the vault — it's cache, not
 * content.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";

export interface ManifestEntry {
  updatedAt?: string;
  /**
   * Whether a companion `.md` was produced alongside a downloaded file. Needed
   * because "has a converter" isn't the same as "produced text" — a scanned PDF
   * has a converter but extracts nothing, and without this the missing `.md`
   * would look like incomplete output and re-download the file every run.
   */
  hasMd?: boolean;
}

export type Manifest = Record<string, ManifestEntry>;

export function loadManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.paths.manifest, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

export function saveManifest(manifest: Manifest): void {
  fs.mkdirSync(path.dirname(CONFIG.paths.manifest), { recursive: true });
  fs.writeFileSync(CONFIG.paths.manifest, JSON.stringify(manifest, null, 2), "utf-8");
}

export function itemKey(courseId: number, itemId: number): string {
  return `${courseId}:${itemId}`;
}
