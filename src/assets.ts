/**
 * Inline images inside Canvas HTML point at authenticated Canvas URLs
 * (".../courses/142383/files/18276527/preview"), so once the page is Markdown in
 * the vault those images are simply broken — Obsidian can't sign in. This pulls
 * each referenced Canvas file down next to the note and rewrites the link to a
 * relative path, so the note renders offline and stays self-contained.
 *
 * Assets go in an `assets/` subfolder of the module directory, deliberately:
 * orphan pruning only sweeps files at the top level of a module folder, so an
 * image can never be mistaken for a stale note and deleted. The trade-off is
 * that assets for a deleted note linger; they're small, and losing a figure is
 * far worse than keeping one too long.
 */

import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "playwright";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { canvasGet, type CanvasFile } from "./canvasApi.js";
import { withRetry, TransientError, isTransientStatus, parseRetryAfter } from "./retry.js";

const ASSETS_DIR = "assets";

/** Markdown images: ![alt](url) and ![alt](url "title"). */
const MD_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g;

/** A Canvas file reference, with the course id when the URL carries one. */
interface FileRef {
  courseId?: string;
  fileId: string;
}

/** Pull the /courses/:cid/files/:fid (or bare /files/:fid) ids out of a URL. */
export function parseFileRef(rawUrl: string): FileRef | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, CONFIG.canvas.baseUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== new URL(CONFIG.canvas.baseUrl).hostname.toLowerCase()) {
    return null;
  }
  const m = parsed.pathname.match(/(?:\/courses\/(\d+))?\/files\/(\d+)/);
  if (!m) return null;
  return { courseId: m[1], fileId: m[2] };
}

/** An already-downloaded asset for this file id, whatever extension it got. */
function existingAsset(dir: string, fileId: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  return fs.readdirSync(dir).find((f) => f === fileId || f.startsWith(`${fileId}.`));
}

function extOf(name: string | undefined): string {
  const m = (name ?? "").match(/\.([a-z0-9]{1,6})$/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Download one Canvas file into <modDir>/assets and return its relative path,
 * or null if it couldn't be fetched (the caller then leaves the original URL).
 */
async function fetchAsset(
  api: APIRequestContext,
  ref: FileRef,
  modDir: string,
): Promise<string | null> {
  const dir = path.join(modDir, ASSETS_DIR);

  const already = existingAsset(dir, ref.fileId);
  if (already) return `${ASSETS_DIR}/${already}`;

  const metaPath = ref.courseId
    ? `/api/v1/courses/${ref.courseId}/files/${ref.fileId}`
    : `/api/v1/files/${ref.fileId}`;

  const { data: file } = await canvasGet<CanvasFile>(api, metaPath);
  if (!file.url) return null;

  const buffer = await withRetry(`asset ${ref.fileId}`, async () => {
    const res = await api.get(file.url!, { timeout: CONFIG.canvas.requestTimeout });
    if (!res.ok()) {
      const message = `Asset download failed (HTTP ${res.status()}) for file ${ref.fileId}`;
      if (isTransientStatus(res.status())) {
        throw new TransientError(message, parseRetryAfter(res.headers()["retry-after"]));
      }
      throw new Error(message);
    }
    return res.body();
  });

  // Name by file id so the same image referenced from several notes in a module
  // is stored once, and so no filename needs escaping in a Markdown link.
  const ext = extOf(file.display_name ?? file.filename);
  const name = ext ? `${ref.fileId}.${ext}` : ref.fileId;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return `${ASSETS_DIR}/${name}`;
}

export interface LocaliseResult {
  markdown: string;
  downloaded: number;
}

/**
 * Rewrite every Canvas-hosted inline image in `markdown` to a local relative
 * path, downloading each one. Failures are logged and left pointing at Canvas —
 * a broken image is a much smaller problem than a failed scrape.
 */
export async function localiseCanvasAssets(
  api: APIRequestContext,
  markdown: string,
  modDir: string,
): Promise<LocaliseResult> {
  const refs = new Map<string, FileRef>();
  for (const [, , url] of markdown.matchAll(MD_IMAGE)) {
    if (refs.has(url)) continue;
    const ref = parseFileRef(url);
    if (ref) refs.set(url, ref);
  }
  if (refs.size === 0) return { markdown, downloaded: 0 };

  let out = markdown;
  let downloaded = 0;

  for (const [url, ref] of refs) {
    try {
      const rel = await fetchAsset(api, ref, modDir);
      if (!rel) continue;
      out = out.split(url).join(rel);
      downloaded += 1;
    } catch (err) {
      log.warn(
        `[asset] Could not localise ${url} (link left pointing at Canvas): ` +
          `${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
  }

  return { markdown: out, downloaded };
}
