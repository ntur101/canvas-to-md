/**
 * Course content that isn't in any module.
 *
 * The module walk is the spine of the scrape, but a Canvas course carries real
 * material outside it: the syllabus (schedule, policies, grading), announcements
 * (where deadline changes and errata land), pages nobody linked into a module,
 * and the Files area. None of it was reachable before, which left visible gaps
 * in what's meant to be a complete corpus.
 *
 * These are written to a sibling of the modules folder, never inside it —
 * orphan pruning treats an unrecognised folder under the modules root as
 * removed-from-Canvas and would delete them.
 */

import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "playwright";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import {
  canvasGet,
  canvasGetAll,
  type CanvasCourse,
  type CanvasDiscussion,
  type CanvasPage,
  type CanvasPageSummary,
  type CanvasFile,
} from "./canvasApi.js";
import { htmlToMarkdown } from "./convert/html.js";
import { extractFileMarkdown } from "./extract.js";
import { localiseCanvasAssets } from "./assets.js";
import { frontmatter, writeText, sanitize, pad2, extOf, NOW } from "./notes.js";
import { withRetry, TransientError, isTransientStatus, parseRetryAfter } from "./retry.js";

export interface ExtrasTally {
  syllabus: number;
  announcements: number;
  unfiledPages: number;
  unfiledFiles: number;
  assetsLocalised: number;
  errors: number;
}

/** HTML body -> Markdown with inline Canvas images pulled local. */
async function bodyToMarkdown(
  api: APIRequestContext,
  html: string | null | undefined,
  dir: string,
  t: ExtrasTally,
): Promise<string> {
  const md = htmlToMarkdown(html);
  if (md === "") return md;
  const { markdown, downloaded } = await localiseCanvasAssets(api, md, dir);
  t.assetsLocalised += downloaded;
  return markdown;
}

function meta(course: CanvasCourse, fields: Record<string, string | undefined>) {
  return frontmatter({ course: course.course_code, scraped: NOW, ...fields });
}

async function scrapeSyllabus(
  api: APIRequestContext,
  course: CanvasCourse,
  dir: string,
  t: ExtrasTally,
): Promise<void> {
  const { data } = await canvasGet<CanvasCourse>(
    api,
    `/api/v1/courses/${course.id}?include[]=syllabus_body`,
  );
  const html = data.syllabus_body;
  if (!html || html.trim() === "") return;

  const md = await bodyToMarkdown(api, html, dir, t);
  if (md === "") return;

  const dest = path.join(dir, "Syllabus.md");
  writeText(
    dest,
    `${meta(course, { title: "Syllabus", type: "Syllabus", canvas_url: `${CONFIG.canvas.baseUrl}/courses/${course.id}/assignments/syllabus` })}` +
      `# Syllabus\n\n${md}\n`,
  );
  t.syllabus += 1;
}

async function scrapeAnnouncements(
  api: APIRequestContext,
  course: CanvasCourse,
  dir: string,
  t: ExtrasTally,
): Promise<void> {
  const topics = await canvasGetAll<CanvasDiscussion & { id?: number }>(
    api,
    `/api/v1/courses/${course.id}/discussion_topics?only_announcements=true&per_page=100`,
  );
  if (topics.length === 0) return;

  // Oldest first, so the numbering is chronological and stable as new ones land
  // at the end rather than renumbering everything.
  const ordered = [...topics].sort((a, b) => String(a.posted_at ?? "").localeCompare(String(b.posted_at ?? "")));
  const outDir = path.join(dir, "Announcements");

  let n = 0;
  for (const topic of ordered) {
    n += 1;
    const md = await bodyToMarkdown(api, topic.message, outDir, t);
    const title = topic.title ?? `Announcement ${n}`;
    const dest = path.join(outDir, `${pad2(n)} - ${sanitize(title)}.md`);
    const posted = topic.posted_at ? `**Posted:** ${topic.posted_at}\n\n` : "";
    writeText(
      dest,
      `${meta(course, { title, type: "Announcement", canvas_url: topic.html_url, posted: topic.posted_at ?? undefined })}` +
        `# ${title}\n\n${posted}${md || "_(no body)_"}\n`,
    );
    t.announcements += 1;
  }
}

/**
 * Pages that exist in the course but aren't linked from any module. `inModules`
 * holds the page slugs the module walk already covered.
 */
async function scrapeUnfiledPages(
  api: APIRequestContext,
  course: CanvasCourse,
  inModules: Set<string>,
  dir: string,
  t: ExtrasTally,
): Promise<void> {
  const pages = await canvasGetAll<CanvasPageSummary>(
    api,
    `/api/v1/courses/${course.id}/pages?per_page=100`,
  );
  const unfiled = pages.filter((p) => p.url && !inModules.has(decodeURIComponent(p.url).toLowerCase()));
  if (unfiled.length === 0) return;

  const outDir = path.join(dir, "Unfiled Pages");
  for (const summary of unfiled) {
    try {
      const { data } = await canvasGet<CanvasPage>(
        api,
        `/api/v1/courses/${course.id}/pages/${summary.url}`,
      );
      const md = await bodyToMarkdown(api, data.body, outDir, t);
      const title = summary.title ?? data.title ?? summary.url ?? "Page";
      writeText(
        path.join(outDir, `${sanitize(title)}.md`),
        `${meta(course, { title, type: "Page", canvas_url: summary.html_url ?? data.html_url })}` +
          `# ${title}\n\n> Not linked from any module.\n\n${md || "_(empty page)_"}\n`,
      );
      t.unfiledPages += 1;
    } catch (err) {
      t.errors += 1;
      log.warn(`[extras] Unfiled page "${summary.title}" failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
}

/**
 * Files in the course Files area not attached to any module. `inModules` holds
 * the file ids the module walk already downloaded.
 */
async function scrapeUnfiledFiles(
  api: APIRequestContext,
  course: CanvasCourse,
  inModules: Set<number>,
  dir: string,
  t: ExtrasTally,
): Promise<void> {
  const files = await canvasGetAll<CanvasFile>(api, `/api/v1/courses/${course.id}/files?per_page=100`);
  const unfiled = files.filter((f) => !inModules.has(f.id));
  if (unfiled.length === 0) return;

  const outDir = path.join(dir, "Unfiled Files");
  for (const file of unfiled) {
    const displayName = file.display_name ?? file.filename ?? `file-${file.id}`;
    try {
      if (!file.url) continue;
      const originalPath = path.join(outDir, sanitize(displayName));
      if (fs.existsSync(originalPath)) continue;

      const buffer = await withRetry(`unfiled file "${displayName}"`, async () => {
        const res = await api.get(file.url!, { timeout: CONFIG.canvas.requestTimeout });
        if (!res.ok()) {
          const message = `Download failed (HTTP ${res.status()}) for "${displayName}"`;
          if (isTransientStatus(res.status())) {
            throw new TransientError(message, parseRetryAfter(res.headers()["retry-after"]));
          }
          throw new Error(message);
        }
        return res.body();
      });

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(originalPath, buffer);
      t.unfiledFiles += 1;

      const originalName = path.basename(originalPath);
      const extracted = await extractFileMarkdown(extOf(displayName), buffer, displayName, originalName);
      if (extracted) {
        writeText(
          `${originalPath}.md`,
          `${meta(course, { title: displayName, type: "File", source_file: originalName, ...extracted.extra })}` +
            `# ${sanitize(displayName)}\n\n> Not attached to any module. ${extracted.note}\n\n${extracted.text}\n`,
        );
      }
    } catch (err) {
      t.errors += 1;
      log.warn(`[extras] Unfiled file "${displayName}" failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
}

export interface ExtrasInput {
  api: APIRequestContext;
  course: CanvasCourse;
  /** Folder for this course's extras (a sibling of the modules folder). */
  dir: string;
  /** Page slugs already covered by the module walk. */
  modulePageSlugs: Set<string>;
  /** File ids already downloaded by the module walk. */
  moduleFileIds: Set<number>;
}

/**
 * Scrape everything outside the modules for one course. Each section is
 * independent and failure-isolated: a course with announcements disabled, or a
 * syllabus you can't read, shouldn't stop the rest.
 */
export async function scrapeExtras(input: ExtrasInput): Promise<ExtrasTally> {
  const { api, course, dir } = input;
  const t: ExtrasTally = {
    syllabus: 0,
    announcements: 0,
    unfiledPages: 0,
    unfiledFiles: 0,
    assetsLocalised: 0,
    errors: 0,
  };

  const sections: Array<[boolean, string, () => Promise<void>]> = [
    [CONFIG.extras.syllabus, "syllabus", () => scrapeSyllabus(api, course, dir, t)],
    [CONFIG.extras.announcements, "announcements", () => scrapeAnnouncements(api, course, dir, t)],
    [CONFIG.extras.unfiledPages, "unfiled pages", () => scrapeUnfiledPages(api, course, input.modulePageSlugs, dir, t)],
    [CONFIG.extras.unfiledFiles, "unfiled files", () => scrapeUnfiledFiles(api, course, input.moduleFileIds, dir, t)],
  ];

  for (const [enabled, label, run] of sections) {
    if (!enabled) continue;
    try {
      await run();
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // A 404 here means the course has that feature switched off (a disabled
      // Pages tab is common), not that anything went wrong. Note it and move on
      // rather than reporting a scrape error the user can't act on.
      if (message.includes("404")) {
        log.info(`[extras] ${label} not enabled for ${course.course_code} — skipped.`);
        continue;
      }
      t.errors += 1;
      log.warn(`[extras] ${label} unavailable for ${course.course_code} (${message})`);
    }
  }

  return t;
}
