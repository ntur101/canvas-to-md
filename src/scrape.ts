/**
 * The scraper: walk each target course's modules and write every item into
 * <output>/<course>/Modules/<NN - module>/<NN - item> — Markdown verbatim, with
 * original files kept alongside.
 *
 * Coverage this build:
 *   Page / Assignment / Quiz  -> HTML->Markdown (lossless)
 *   File (pdf/pptx/xlsx)      -> download original + extracted-text .md
 *   File (other)              -> download original
 *   ExternalUrl (SharePoint)  -> download + convert + keep the original
 *   ExternalUrl (other)       -> link recorded as a small .md
 *   SubHeader                 -> skipped (a divider, no content)
 *   Linked file (not a module item, found via a page/quiz/assignment body) ->
 *     downloaded + converted the same way a File module item is, written under
 *     Course Info/Linked Files/ (see fetchLinkedFiles)
 *
 * Repeat runs are incremental (src/manifest.ts) and can prune the files left
 * behind by items renamed, reordered, or removed on Canvas — see pruneOrphans.
 */

import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "playwright";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import {
  makeCanvasContext,
  canvasGet,
  canvasGetAll,
  type CanvasCourse,
  type CanvasModule,
  type CanvasModuleItem,
  type CanvasPage,
  type CanvasAssignment,
  type CanvasQuiz,
  type CanvasQuizQuestion,
  type CanvasRubricCriterion,
  type CanvasDiscussion,
  type CanvasFile,
} from "./canvasApi.js";
import { getScrapeCourses } from "./courses.js";
import { ensureCanvasSession } from "./auth.js";
import { htmlToMarkdown } from "./convert/html.js";
import { localiseCanvasAssets } from "./assets.js";
import { extractFileMarkdown } from "./extract.js";
import { downloadSharePointFile } from "./sharepoint.js";
import { loadManifest, saveManifest, itemKey, type Manifest } from "./manifest.js";
import { withRetry, TransientError, isTransientStatus, parseRetryAfter } from "./retry.js";
import { pad2, sanitize, frontmatter, writeText, extOf, hostOf, NOW } from "./notes.js";
import {
  rewriteInternalLinks,
  pageKey,
  contentKey,
  moduleItemKey,
  type LinkIndex,
  type PageRef,
  type FileRef,
} from "./links.js";
import { scrapeExtras } from "./extras.js";

interface Tally {
  pages: number;
  assignments: number;
  quizzes: number;
  discussions: number;
  assetsLocalised: number;
  linksRewritten: number;
  rubrics: number;
  quizQuestions: number;
  linkedPages: number;
  linkedFiles: number;
  linkedFilesConverted: number;
  syllabi: number;
  announcements: number;
  unfiledPages: number;
  unfiledFiles: number;
  filesDownloaded: number;
  filesConverted: number;
  sharepointDownloaded: number;
  sharepointConverted: number;
  sharepointFallbackLinks: number;
  links: number;
  subheadersSkipped: number;
  skipped: number;
  orphansFound: number;
  orphansRemoved: number;
  prunesHeldBack: number;
  errors: number;
}

export function newTally(): Tally {
  return {
    pages: 0,
    assignments: 0,
    quizzes: 0,
    discussions: 0,
    assetsLocalised: 0,
    linksRewritten: 0,
    rubrics: 0,
    quizQuestions: 0,
    linkedPages: 0,
    linkedFiles: 0,
    linkedFilesConverted: 0,
    syllabi: 0,
    announcements: 0,
    unfiledPages: 0,
    unfiledFiles: 0,
    filesDownloaded: 0,
    filesConverted: 0,
    sharepointDownloaded: 0,
    sharepointConverted: 0,
    sharepointFallbackLinks: 0,
    links: 0,
    subheadersSkipped: 0,
    skipped: 0,
    orphansFound: 0,
    orphansRemoved: 0,
    prunesHeldBack: 0,
    errors: 0,
  };
}

/**
 * Counts are kept per course and folded into the run total at the end, so the
 * summary can say which course each number came from. Every field is a count,
 * so the fold is a plain field-by-field sum.
 */
export function addTally(into: Tally, from: Tally): void {
  for (const key of Object.keys(from) as (keyof Tally)[]) into[key] += from[key];
}

/** The tally for one course, created on first use. */
function tallyFor(tallies: Map<number, Tally>, courseId: number): Tally {
  let t = tallies.get(courseId);
  if (!t) {
    t = newTally();
    tallies.set(courseId, t);
  }
  return t;
}

/**
 * What one module folder looked like to this run: the files we vouch for, and
 * whether anything went wrong. Both feed orphan pruning — a module with any
 * unresolved item is never pruned, since a failure would otherwise look
 * indistinguishable from "removed from Canvas".
 */
interface ModuleState {
  dir: string;
  keep: Set<string>;
  issues: number;
}

/** Everything a per-item handler needs. */
interface ItemCtx {
  api: APIRequestContext;
  course: CanvasCourse;
  moduleName: string;
  item: CanvasModuleItem;
  /** 1-based position in the module — the "NN - " filename prefix. */
  num: number;
  mod: ModuleState;
  /** Destination for items that are a single .md. */
  mdDest: string;
  t: Tally;
  manifest: Manifest;
  incremental: boolean;
  /** Every scraped item, for rewriting internal Canvas links to local ones. */
  links: LinkIndex;
  /** Linked-but-unscraped Canvas pages discovered while rewriting, to fetch later. */
  pending: Map<string, PageRef>;
  /** Linked-but-unscraped Canvas files discovered while rewriting, to fetch later. */
  pendingFiles: Map<string, FileRef>;
  /** File ids already covered by a File-type module item in this course. */
  moduleFileIds: Set<number>;
}

/** Vouch for a path: anything in the module folder not vouched for is orphaned. */
function keep(c: ItemCtx, ...paths: string[]): void {
  for (const p of paths) c.mod.keep.add(path.resolve(p).toLowerCase());
}

/** Flag the module as incomplete, which holds back pruning for it. */
function markIssue(c: ItemCtx): void {
  c.mod.issues += 1;
}

// per-item handlers

/** Common frontmatter for a content item. */
function itemMeta(c: ItemCtx): Record<string, string | undefined> {
  return {
    title: c.item.title,
    course: c.course.course_code,
    module: c.moduleName,
    type: c.item.type,
    canvas_url: c.item.html_url,
    scraped: NOW,
  };
}

/**
 * True when the cached `updated_at` still matches and the output is on disk.
 * The existence check is what makes renames safe: a retitled item resolves to a
 * new filename, so the old file is missing here and the item is rewritten (the
 * stale one is then caught as an orphan).
 */
function isUnchanged(c: ItemCtx, key: string, updatedAt: string | undefined, dest: string): boolean {
  return Boolean(updatedAt) && c.manifest[key]?.updatedAt === updatedAt && fs.existsSync(dest);
}

/**
 * A Canvas HTML body as Markdown, with its inline Canvas images pulled local so
 * they still render in the vault. Shared by every HTML-bodied item type.
 */
async function bodyToMarkdown(c: ItemCtx, html: string | null | undefined): Promise<string> {
  const md = htmlToMarkdown(html);
  if (md === "") return md;

  const { markdown, downloaded } = await localiseCanvasAssets(c.api, md, c.mod.dir);
  c.t.assetsLocalised += downloaded;

  if (!CONFIG.scrape.linkInternally) return markdown;
  const linked = rewriteInternalLinks(markdown, c.links, c.mod.dir);
  c.t.linksRewritten += linked.rewritten;
  for (const ref of linked.unresolvedPages) c.pending.set(`${ref.courseId}:${ref.slug.toLowerCase()}`, ref);
  for (const ref of linked.unresolvedFiles) {
    // Already covered by a File-type module item elsewhere in this course —
    // that copy is authoritative, so this link is left as a URL rather than
    // risk a duplicate download under a different name.
    if (c.moduleFileIds.has(Number(ref.fileId))) continue;
    c.pendingFiles.set(`${ref.courseId}:${ref.fileId}`, ref);
  }
  return linked.markdown;
}

async function handlePage(c: ItemCtx): Promise<void> {
  if (!c.item.page_url) {
    markIssue(c);
    log.warn(`[page] No page_url for "${c.item.title}" — skipped.`);
    return;
  }
  const { data } = await canvasGet<CanvasPage>(
    c.api,
    `/api/v1/courses/${c.course.id}/pages/${c.item.page_url}`,
  );
  const key = itemKey(c.course.id, c.item.id);
  keep(c, c.mdDest);
  if (c.incremental && isUnchanged(c, key, data.updated_at, c.mdDest)) {
    c.t.skipped += 1;
    return;
  }
  const md = await bodyToMarkdown(c, data.body);
  const heading = c.item.title ?? data.title ?? "Page";
  const body = `${frontmatter(itemMeta(c))}# ${heading}\n\n${md || "_(empty page)_"}\n`;
  writeText(c.mdDest, body);
  c.manifest[key] = { updatedAt: data.updated_at };
  c.t.pages += 1;
}

/**
 * A rubric as a Markdown section. Rubrics are usually the real grading criteria,
 * and they're the part of an assignment students actually need, so they're
 * rendered in full rather than summarised: one subsection per criterion with its
 * rating bands as a table.
 */
export function rubricToMarkdown(rubric: CanvasRubricCriterion[] | undefined): string {
  if (!rubric || rubric.length === 0) return "";

  const parts = ["## Rubric"];
  for (const criterion of rubric) {
    const points = criterion.points != null ? ` (${criterion.points} pts)` : "";
    parts.push(`### ${criterion.description ?? "Criterion"}${points}`);
    if (criterion.long_description) parts.push(htmlToMarkdown(criterion.long_description));

    const ratings = criterion.ratings ?? [];
    if (ratings.length > 0) {
      const rows = ratings.map((r) => {
        const desc = (r.description ?? "").replace(/\|/g, "\\|");
        const long = htmlToMarkdown(r.long_description ?? "").replace(/\n+/g, " ").replace(/\|/g, "\\|");
        return `| ${r.points ?? ""} | ${desc} | ${long} |`;
      });
      parts.push(["| Points | Rating | Detail |", "| --- | --- | --- |", ...rows].join("\n"));
    }
  }
  return parts.join("\n\n");
}

/**
 * Quiz questions as Markdown. Canvas often refuses this endpoint for students
 * (questions can be hidden until an attempt, or entirely), so a failure is
 * expected rather than exceptional — it returns null and the quiz note is
 * written without them.
 */
async function fetchQuizQuestions(c: ItemCtx, quizId: number): Promise<string | null> {
  let questions: CanvasQuizQuestion[];
  try {
    questions = await canvasGetAll<CanvasQuizQuestion>(
      c.api,
      `/api/v1/courses/${c.course.id}/quizzes/${quizId}/questions?per_page=100`,
    );
  } catch {
    log.info(`[quiz] Questions not available for "${c.item.title}" (normal for students) — description only.`);
    return null;
  }
  if (questions.length === 0) return null;

  const ordered = [...questions].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const parts = ["## Questions"];
  let n = 0;
  for (const q of ordered) {
    n += 1;
    const points = q.points_possible != null ? ` (${q.points_possible} pts)` : "";
    const type = q.question_type ? ` _[${q.question_type.replace(/_/g, " ")}]_` : "";
    parts.push(`### ${n}. ${q.question_name ?? `Question ${n}`}${points}${type}`);
    const text = htmlToMarkdown(q.question_text);
    if (text) parts.push(text);

    const answers = (q.answers ?? []).map((a) => htmlToMarkdown(a.html ?? "") || a.text || "").filter(Boolean);
    if (answers.length > 0) {
      parts.push(answers.map((a) => `- ${a.replace(/\n+/g, " ")}`).join("\n"));
    }
  }
  c.t.quizQuestions += n;
  return parts.join("\n\n");
}

async function handleAssignment(c: ItemCtx): Promise<void> {
  if (!c.item.content_id) {
    markIssue(c);
    log.warn(`[assignment] No content_id for "${c.item.title}" — skipped.`);
    return;
  }
  const { data } = await canvasGet<CanvasAssignment>(
    c.api,
    `/api/v1/courses/${c.course.id}/assignments/${c.item.content_id}`,
  );
  const key = itemKey(c.course.id, c.item.id);
  keep(c, c.mdDest);
  if (c.incremental && isUnchanged(c, key, data.updated_at, c.mdDest)) {
    c.t.skipped += 1;
    return;
  }
  const meta: string[] = [];
  if (data.due_at) meta.push(`**Due:** ${data.due_at}`);
  if (data.points_possible != null) meta.push(`**Points:** ${data.points_possible}`);
  const md = await bodyToMarkdown(c, data.description);
  const heading = c.item.title ?? data.name ?? "Assignment";
  const metaLine = meta.length ? meta.join("  |  ") + "\n\n" : "";
  const rubric = CONFIG.scrape.includeRubrics ? rubricToMarkdown(data.rubric) : "";
  if (rubric) c.t.rubrics += 1;
  const body =
    `${frontmatter(itemMeta(c))}# ${heading}\n\n${metaLine}${md || "_(no description)_"}\n` +
    `${rubric ? `\n${rubric}\n` : ""}`;
  writeText(c.mdDest, body);
  c.manifest[key] = { updatedAt: data.updated_at };
  c.t.assignments += 1;
}

async function handleQuiz(c: ItemCtx): Promise<void> {
  if (!c.item.content_id) {
    markIssue(c);
    log.warn(`[quiz] No content_id for "${c.item.title}" — skipped.`);
    return;
  }
  const { data } = await canvasGet<CanvasQuiz>(
    c.api,
    `/api/v1/courses/${c.course.id}/quizzes/${c.item.content_id}`,
  );
  const key = itemKey(c.course.id, c.item.id);
  keep(c, c.mdDest);
  if (c.incremental && isUnchanged(c, key, data.updated_at, c.mdDest)) {
    c.t.skipped += 1;
    return;
  }
  const meta: string[] = [];
  if (data.due_at) meta.push(`**Due:** ${data.due_at}`);
  if (data.points_possible != null) meta.push(`**Points:** ${data.points_possible}`);
  const md = await bodyToMarkdown(c, data.description);
  const heading = c.item.title ?? data.title ?? "Quiz";
  const metaLine = meta.length ? meta.join("  |  ") + "\n\n" : "";
  const questions = CONFIG.scrape.includeQuizQuestions
    ? await fetchQuizQuestions(c, c.item.content_id)
    : null;
  const body =
    `${frontmatter(itemMeta(c))}# ${heading}\n\n${metaLine}${md || "_(no description)_"}\n` +
    `${questions ? `\n${questions}\n` : ""}`;
  writeText(c.mdDest, body);
  c.manifest[key] = { updatedAt: data.updated_at };
  c.t.quizzes += 1;
}

/**
 * Discussion topics. Captures the topic body — the prompt an instructor wrote,
 * which is course content. Replies are deliberately not fetched: they're a
 * separate paginated endpoint, they're mostly student conversation rather than
 * material, and they'd churn the incremental check on every run.
 */
async function handleDiscussion(c: ItemCtx): Promise<void> {
  if (!c.item.content_id) {
    markIssue(c);
    log.warn(`[discussion] No content_id for "${c.item.title}" — skipped.`);
    return;
  }
  const { data } = await canvasGet<CanvasDiscussion>(
    c.api,
    `/api/v1/courses/${c.course.id}/discussion_topics/${c.item.content_id}`,
  );
  const key = itemKey(c.course.id, c.item.id);
  keep(c, c.mdDest);
  if (c.incremental && isUnchanged(c, key, data.updated_at, c.mdDest)) {
    c.t.skipped += 1;
    return;
  }
  const md = await bodyToMarkdown(c, data.message);
  const heading = c.item.title ?? data.title ?? "Discussion";
  const postedLine = data.posted_at ? `**Posted:** ${data.posted_at}\n\n` : "";
  const body =
    `${frontmatter(itemMeta(c))}# ${heading}\n\n${postedLine}${md || "_(no prompt text)_"}\n\n` +
    `> Topic prompt only — replies are not scraped.\n`;
  writeText(c.mdDest, body);
  c.manifest[key] = { updatedAt: data.updated_at };
  c.t.discussions += 1;
}

async function handleFile(c: ItemCtx): Promise<void> {
  if (!c.item.content_id) {
    markIssue(c);
    log.warn(`[file] No content_id for "${c.item.title}" — skipped.`);
    return;
  }
  const { data: file } = await canvasGet<CanvasFile>(
    c.api,
    `/api/v1/courses/${c.course.id}/files/${c.item.content_id}`,
  );
  const displayName = file.display_name ?? file.filename ?? c.item.title ?? `file-${c.item.content_id}`;
  const originalName = `${pad2(c.num)} - ${sanitize(displayName)}`;
  const originalPath = path.join(c.mod.dir, originalName);
  const mdPath = `${originalPath}.md`;
  const key = itemKey(c.course.id, c.item.id);
  const cached = c.manifest[key];

  if (c.incremental) {
    // "Had a converter" isn't the same as "produced a .md" — a scanned PDF
    // extracts nothing — so the manifest records what was actually written.
    const outputsPresent = fs.existsSync(originalPath) && (!cached?.hasMd || fs.existsSync(mdPath));
    const unchanged = Boolean(file.updated_at) && cached?.updatedAt === file.updated_at;
    if (unchanged && outputsPresent) {
      keep(c, originalPath);
      if (cached?.hasMd) keep(c, mdPath);
      c.t.skipped += 1;
      return;
    }
  }

  if (!file.url) {
    markIssue(c);
    log.warn(`[file] No download URL for "${displayName}" — skipped.`);
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await withRetry(`file "${displayName}"`, async () => {
      const res = await c.api.get(file.url!, { timeout: CONFIG.canvas.requestTimeout });
      if (!res.ok()) {
        const message = `Download failed (HTTP ${res.status()}) for "${displayName}"`;
        if (isTransientStatus(res.status())) {
          throw new TransientError(message, parseRetryAfter(res.headers()["retry-after"]));
        }
        throw new Error(message);
      }
      return res.body();
    });
  } catch (err) {
    markIssue(c);
    c.t.errors += 1;
    log.warn(`[file] ${err instanceof Error ? err.message : String(err)} — skipped.`);
    return;
  }

  fs.mkdirSync(c.mod.dir, { recursive: true });
  fs.writeFileSync(originalPath, buffer);
  keep(c, originalPath);
  c.t.filesDownloaded += 1;

  // Convert to an extracted-text companion where we have a converter (pdf, pptx,
  // xlsx). Types without one (zip, images, …) keep just the original.
  const extracted = await extractFileMarkdown(extOf(displayName), buffer, displayName, originalName);
  if (extracted) {
    const mdMeta = { ...itemMeta(c), ...extracted.extra, source_file: originalName };
    const mdBody =
      `${frontmatter(mdMeta)}# ${sanitize(displayName)}\n\n> ${extracted.note}\n\n${extracted.text}\n`;
    writeText(mdPath, mdBody);
    keep(c, mdPath);
    c.t.filesConverted += 1;
  }
  c.manifest[key] = { updatedAt: file.updated_at, hasMd: Boolean(extracted) };
}

/** Write a small note that just records an external link (forms, Panopto, etc.). */
function writeLinkNote(c: ItemCtx, dest: string, extraNote = ""): void {
  // ExternalTool items don't always carry an external_url; their Canvas page is
  // the only stable address, so fall back to it rather than writing "undefined".
  const url = c.item.external_url ?? c.item.html_url ?? "";
  const heading = c.item.title ?? "External link";
  const link = url ? `[${url}](${url})\n` : "_(no link recorded on this item)_\n";
  const body =
    `${frontmatter({ ...itemMeta(c), external_host: hostOf(url) })}` +
    `# ${heading}\n\n${link}${extraNote ? `\n${extraNote}\n` : ""}`;
  writeText(dest, body);
}

function handleExternalUrl(c: ItemCtx): void {
  writeLinkNote(c, c.mdDest);
  keep(c, c.mdDest);
  c.t.links += 1;
}

/**
 * LTI tools (Panopto, publisher platforms, …). The content lives in another
 * system entirely and isn't reachable through the Canvas API, so the honest
 * output is a link note — previously these fell through to "unhandled type" and
 * left no trace in the vault at all.
 */
function handleExternalTool(c: ItemCtx): void {
  writeLinkNote(c, c.mdDest, "> External tool (LTI) — content lives outside Canvas and isn't scraped.");
  keep(c, c.mdDest);
  c.t.links += 1;
}

async function handleSharePoint(c: ItemCtx): Promise<void> {
  const url = c.item.external_url;
  if (!url) {
    markIssue(c);
    log.warn(`[sharepoint] No external_url for "${c.item.title}" — skipped.`);
    return;
  }

  const base = `${pad2(c.num)} - ${sanitize(c.item.title)}`;

  // A download this item produced on an earlier run, if any. The original is the
  // one without the .md suffix (the companion is "<original>.md").
  const existing = fs.existsSync(c.mod.dir)
    ? fs.readdirSync(c.mod.dir).find((f) => f.startsWith(`${base}.`) && !f.endsWith(".md"))
    : undefined;
  const existingPath = existing ? path.join(c.mod.dir, existing) : undefined;

  // Canvas exposes no updated_at for ExternalUrl items, so this can only go on
  // file presence: once a deck is downloaded, it's not re-fetched unless its
  // local copy is deleted. That also means an already-downloaded deck never
  // needs a live (and easily expired) SharePoint session again.
  if (c.incremental && existingPath) {
    keep(c, existingPath, `${existingPath}.md`);
    c.t.skipped += 1;
    return;
  }

  const file = await downloadSharePointFile(url);
  if (!file) {
    // An earlier run already got this deck and the session has since expired (or
    // this is a --force run): keep what's on disk. Downgrading a real download to
    // a link note would lose content, and would then read as an orphan to prune.
    if (existingPath) {
      keep(c, existingPath, `${existingPath}.md`);
      log.warn(`[sharepoint] Download unavailable for "${c.item.title}" — keeping the copy from an earlier run.`);
      c.t.skipped += 1;
      return;
    }
    // Nothing downloaded yet — record the link so the item isn't lost. Not an
    // "issue": a link note is a legitimate output, and an expired SharePoint
    // session is common enough that it shouldn't hold back the whole module.
    writeLinkNote(
      c,
      c.mdDest,
      "> SharePoint download unavailable (session may need `npm run setup-auth-sharepoint`). Linked only.",
    );
    keep(c, c.mdDest);
    c.t.sharepointFallbackLinks += 1;
    return;
  }

  const ext = file.ext || "bin";
  const originalPath = path.join(c.mod.dir, `${base}.${ext}`);
  const mdPath = `${originalPath}.md`;
  fs.mkdirSync(c.mod.dir, { recursive: true });
  fs.writeFileSync(originalPath, file.buffer);
  keep(c, originalPath, mdPath);
  c.t.sharepointDownloaded += 1;

  // A plain "<base>.md" here is a stale link-note from a run before this file was
  // downloadable — remove it so it doesn't sit beside the real .<ext>.md.
  fs.rmSync(c.mdDest, { force: true });

  const originalName = path.basename(originalPath);
  const meta = { ...itemMeta(c), source_url: url, source_file: originalName };
  const extracted = await extractFileMarkdown(ext, file.buffer, c.item.title ?? originalName, originalName);

  if (extracted) {
    const mdBody =
      `${frontmatter({ ...meta, ...extracted.extra })}# ${sanitize(c.item.title)}\n\n` +
      `> ${extracted.note}\n\n${extracted.text}\n`;
    writeText(mdPath, mdBody);
    c.t.sharepointConverted += 1;
  } else {
    // Downloaded but no converter (or empty extraction): leave a pointer .md.
    const mdBody =
      `${frontmatter(meta)}# ${sanitize(c.item.title)}\n\n` +
      `> Original downloaded as \`${originalName}\`. No text could be extracted — open the original.\n`;
    writeText(mdPath, mdBody);
  }
}

// orphan cleanup

/**
 * Files in a module folder that this run didn't vouch for: what's left when an
 * item is renamed, reordered, or deleted on Canvas. Only deleted when `prune` is
 * on — off unless `scrape.pruneOrphans` is enabled in settings.json, since the
 * output root may be a vault holding files this run knows nothing about.
 * Otherwise they are just reported. Held back entirely for modules where
 * something went wrong.
 */
export function sweepModule(mod: ModuleState, prune: boolean, t: Tally): void {
  if (!fs.existsSync(mod.dir)) return;
  if (mod.issues > 0) {
    t.prunesHeldBack += 1;
    log.warn(`[orphan] Skipping cleanup of "${path.basename(mod.dir)}" — ${mod.issues} unresolved item(s) this run.`);
    return;
  }

  for (const entry of fs.readdirSync(mod.dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(mod.dir, entry.name);
    if (mod.keep.has(path.resolve(full).toLowerCase())) continue;

    if (prune) {
      fs.rmSync(full, { force: true });
      t.orphansRemoved += 1;
      log.info(`[orphan] Removed ${path.basename(mod.dir)}/${entry.name}`);
    } else {
      t.orphansFound += 1;
      log.warn(`[orphan] ${path.basename(mod.dir)}/${entry.name} is no longer in Canvas (run with --prune to remove)`);
    }
  }

  // A module emptied by pruning leaves a stray folder behind.
  if (prune && fs.readdirSync(mod.dir).length === 0) {
    fs.rmdirSync(mod.dir);
    log.info(`[orphan] Removed empty folder ${path.basename(mod.dir)}`);
  }
}

/** The same idea one level up: module folders that no longer exist on Canvas. */
export function sweepCourse(courseDir: string, visited: Set<string>, courseIssues: number, prune: boolean, t: Tally): void {
  if (!fs.existsSync(courseDir)) return;
  if (courseIssues > 0) return;

  for (const entry of fs.readdirSync(courseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(courseDir, entry.name);
    if (visited.has(path.resolve(full).toLowerCase())) continue;

    if (prune) {
      fs.rmSync(full, { recursive: true, force: true });
      t.orphansRemoved += 1;
      log.info(`[orphan] Removed module folder ${entry.name}/`);
    } else {
      t.orphansFound += 1;
      log.warn(`[orphan] Module folder ${entry.name}/ is no longer in Canvas (run with --prune to remove)`);
    }
  }
}


// planning

/** One module item, with its destination resolved ahead of the run. */
interface PlannedItem {
  item: CanvasModuleItem;
  num: number;
  mdDest: string;
}

interface PlannedModule {
  moduleName: string;
  dir: string;
  items: PlannedItem[];
}

interface PlannedCourse {
  course: CanvasCourse;
  /** <output>/<course>/Modules */
  courseDir: string;
  /** <output>/<course>/Course Info — a sibling, never inside courseDir. */
  extrasDir: string;
  modules: PlannedModule[];
  /** Page slugs and file ids the module walk covers, so extras can skip them. */
  pageSlugs: Set<string>;
  fileIds: Set<number>;
}

/**
 * Walk the structure of every course before writing anything.
 *
 * Two reasons this is a separate pass. Internal links can point forward — to a
 * page in a later module, or in another course — so the index of "what will
 * exist in the vault" has to be complete before the first note is written. And
 * the extras pass needs to know which pages and files the modules already
 * cover, to avoid scraping them twice.
 */
async function planRun(
  api: APIRequestContext,
  courses: CanvasCourse[],
  links: LinkIndex,
): Promise<PlannedCourse[]> {
  const planned: PlannedCourse[] = [];

  for (const course of courses) {
    const folder =
      CONFIG.scrape.courseFolders[course.course_code ?? ""] ??
      course.course_code?.replace(/\s+/g, "-") ??
      String(course.id);
    const courseRoot = path.join(CONFIG.paths.output, folder);
    const courseDir = path.join(courseRoot, CONFIG.scrape.subfolder);

    const modules = (
      await canvasGetAll<CanvasModule>(api, `/api/v1/courses/${course.id}/modules?per_page=100`)
    ).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const entry: PlannedCourse = {
      course,
      courseDir,
      extrasDir: path.join(courseRoot, CONFIG.extras.folder),
      modules: [],
      pageSlugs: new Set<string>(),
      fileIds: new Set<number>(),
    };

    let modNum = 0;
    for (const mod of modules) {
      modNum += 1;
      const moduleName = mod.name ?? `Module ${modNum}`;
      const dir = path.join(courseDir, `${pad2(modNum)} - ${sanitize(moduleName)}`);

      const items = (
        await canvasGetAll<CanvasModuleItem>(
          api,
          `/api/v1/courses/${course.id}/modules/${mod.id}/items?per_page=100`,
        )
      ).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

      const plannedItems: PlannedItem[] = [];
      let itemNum = 0;
      for (const item of items) {
        itemNum += 1;
        const basename = `${pad2(itemNum)} - ${sanitize(item.title)}`;
        const mdDest = path.join(dir, `${basename}.md`);
        plannedItems.push({ item, num: itemNum, mdDest });

        if (item.type === "Page" && item.page_url) {
          entry.pageSlugs.add(decodeURIComponent(item.page_url).toLowerCase());
        }
        if (item.type === "File" && item.content_id) entry.fileIds.add(item.content_id);

        // Only item types whose note filename is known from the listing get
        // indexed. A File's note is named after the file's display_name, which
        // needs a fetch, and a SharePoint item's note gets an extension suffix —
        // links to those stay as plain URLs rather than risk a dead wikilink.
        const target = { basename, fullPath: mdDest };
        switch (item.type) {
          case "Page":
            if (item.page_url) links.set(pageKey(course.id, item.page_url), target);
            links.set(moduleItemKey(course.id, item.id), target);
            break;
          case "Assignment":
            if (item.content_id) links.set(contentKey("assignment", course.id, item.content_id), target);
            links.set(moduleItemKey(course.id, item.id), target);
            break;
          case "Quiz":
            if (item.content_id) links.set(contentKey("quiz", course.id, item.content_id), target);
            links.set(moduleItemKey(course.id, item.id), target);
            break;
          case "Discussion":
            if (item.content_id) links.set(contentKey("discussion", course.id, item.content_id), target);
            links.set(moduleItemKey(course.id, item.id), target);
            break;
          default:
            break;
        }
      }

      entry.modules.push({ moduleName, dir, items: plannedItems });
    }

    planned.push(entry);
  }

  return planned;
}

// linked-page discovery

/**
 * Fetch Canvas pages that are linked from scraped content but never appeared in
 * any module — and that the pages listing can't find either, because a course
 * with its Pages tab disabled 404s that endpoint. Following the links is then
 * the only way to reach real material: SOFTENG 761's "card" pages held ~25KB of
 * content that was invisible before this existed.
 *
 * Runs in rounds, since a discovered page can link to further ones. Each new
 * page joins the index so the final pass can point links at it.
 */
async function fetchLinkedPages(
  api: APIRequestContext,
  pending: Map<string, PageRef>,
  byCourseId: Map<string, PlannedCourse>,
  links: LinkIndex,
  tallies: Map<number, Tally>,
  pendingFiles: Map<string, FileRef>,
): Promise<void> {
  const done = new Set<string>();

  for (let round = 1; round <= CONFIG.scrape.linkedPageRounds && pending.size > 0; round += 1) {
    const batch = [...pending.entries()].filter(([key]) => !done.has(key));
    pending.clear();
    if (batch.length === 0) break;

    for (const [key, ref] of batch) {
      done.add(key);
      const planned = byCourseId.get(ref.courseId);
      // A link into a course we aren't scraping: leave it as a URL.
      if (!planned) continue;

      // Credited to the course the page belongs to, not the one that linked it.
      const t = tallyFor(tallies, planned.course.id);
      const dir = path.join(planned.extrasDir, "Linked Pages");
      try {
        const { data } = await canvasGet<CanvasPage>(
          api,
          `/api/v1/courses/${ref.courseId}/pages/${ref.slug}`,
        );
        const title = data.title ?? ref.slug;
        const dest = path.join(dir, `${sanitize(title)}.md`);

        const md = htmlToMarkdown(data.body);
        const { markdown: withAssets, downloaded } = await localiseCanvasAssets(api, md, dir);
        t.assetsLocalised += downloaded;

        // Rewrite what we can now; anything still unresolved feeds the next round.
        const linked = rewriteInternalLinks(withAssets, links, dir);
        t.linksRewritten += linked.rewritten;
        for (const next of linked.unresolvedPages) {
          pending.set(`${next.courseId}:${next.slug.toLowerCase()}`, next);
        }
        for (const next of linked.unresolvedFiles) {
          if (!planned.fileIds.has(Number(next.fileId))) {
            pendingFiles.set(`${next.courseId}:${next.fileId}`, next);
          }
        }

        writeText(
          dest,
          `${frontmatter({
            title,
            course: planned.course.course_code,
            type: "Page",
            canvas_url: data.html_url,
            scraped: NOW,
          })}# ${title}\n\n> Linked from course content but not in any module.\n\n` +
            `${linked.markdown || "_(empty page)_"}\n`,
        );

        links.set(pageKey(ref.courseId, ref.slug), { basename: sanitize(title), fullPath: dest });
        t.linkedPages += 1;
      } catch (err) {
        // Expected for pages you can't read; the link just stays a URL.
        log.info(
          `[linked] Could not fetch page "${ref.slug}" in course ${ref.courseId}: ` +
            `${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
      }
    }
  }
}

// linked-file discovery

/**
 * Fetch Canvas files that are linked from scraped content but aren't a
 * File-type module item anywhere in the course — e.g. a PDF hyperlinked inside
 * a Quiz's own description, rather than attached as its own module item (which
 * handleFile already covers). Written under Course Info/Linked Files/, using
 * the same download-then-extract approach as handleFile.
 *
 * A single pass, unlike fetchLinkedPages: the extracted text of a file is never
 * re-run through link rewriting, so fetching one can't surface further pending
 * links the way a fetched page can.
 */
async function fetchLinkedFiles(
  api: APIRequestContext,
  pending: Map<string, FileRef>,
  byCourseId: Map<string, PlannedCourse>,
  links: LinkIndex,
  tallies: Map<number, Tally>,
): Promise<void> {
  const batch = [...pending.entries()];
  pending.clear();

  for (const [, ref] of batch) {
    const planned = byCourseId.get(ref.courseId);
    // A link into a course we aren't scraping, or a file a module item already
    // covers elsewhere in the vault (that copy is authoritative): leave as a URL.
    if (!planned || planned.fileIds.has(Number(ref.fileId))) continue;

    const t = tallyFor(tallies, planned.course.id);
    const dir = path.join(planned.extrasDir, "Linked Files");

    try {
      const { data: file } = await canvasGet<CanvasFile>(
        api,
        `/api/v1/courses/${ref.courseId}/files/${ref.fileId}`,
      );
      const displayName = file.display_name ?? file.filename ?? `file-${ref.fileId}`;
      const originalName = sanitize(displayName);
      const originalPath = path.join(dir, originalName);
      const mdPath = `${originalPath}.md`;

      // Existence-based, the same as the unfiled-files sweep in src/extras.ts:
      // Canvas gives no cheap signal for "this changed" outside a module item,
      // so a downloaded file is only replaced once its local copy is gone.
      if (fs.existsSync(originalPath)) {
        links.set(contentKey("file", ref.courseId, ref.fileId), {
          basename: originalName,
          fullPath: fs.existsSync(mdPath) ? mdPath : originalPath,
        });
        t.skipped += 1;
        continue;
      }

      if (!file.url) {
        log.warn(`[linked-file] No download URL for "${displayName}" — left as a link.`);
        continue;
      }

      const buffer = await withRetry(`linked file "${displayName}"`, async () => {
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

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(originalPath, buffer);
      links.set(contentKey("file", ref.courseId, ref.fileId), { basename: originalName, fullPath: originalPath });
      t.linkedFiles += 1;

      const extracted = await extractFileMarkdown(extOf(displayName), buffer, displayName, originalName);
      if (extracted) {
        const mdMeta = {
          title: displayName,
          course: planned.course.course_code,
          type: "File",
          canvas_url: file.url,
          source_file: originalName,
          scraped: NOW,
          ...extracted.extra,
        };
        writeText(
          mdPath,
          `${frontmatter(mdMeta)}# ${sanitize(displayName)}\n\n` +
            `> Linked from course content but not attached to any module. ${extracted.note}\n\n${extracted.text}\n`,
        );
        links.set(contentKey("file", ref.courseId, ref.fileId), { basename: originalName, fullPath: mdPath });
        t.linkedFilesConverted += 1;
      }
    } catch (err) {
      // Expected for files you can't read; the link just stays a URL.
      log.info(
        `[linked-file] Could not fetch file ${ref.fileId} in course ${ref.courseId}: ` +
          `${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
  }
}

/**
 * Re-apply link rewriting to every note on disk once the index is final.
 *
 * Notes written before a linked page/file was discovered still point at
 * Canvas, and incrementally-skipped notes were never rewritten this run at
 * all. Rewriting is idempotent (a wikilink is no longer a Markdown link to a
 * Canvas URL), so this is safe to run over everything, and it's pure file I/O
 * — no network.
 *
 * Mutates pendingPages/pendingFiles with what it finds, rather than returning
 * a fresh map, so the same accumulators used elsewhere in the run keep
 * growing. Reading unresolved links from disk rather than only from
 * freshly-written notes is what makes discovery work on an incremental run,
 * where the note holding the link is skipped and never re-rendered.
 */
function resolveLinksOnDisk(
  plan: PlannedCourse[],
  links: LinkIndex,
  tallies: Map<number, Tally>,
  pendingPages: Map<string, PageRef>,
  pendingFiles: Map<string, FileRef>,
): void {
  // Walked one course at a time so each rewrite is credited to the course whose
  // note it was found in.
  for (const planned of plan) {
    const t = tallyFor(tallies, planned.course.id);
    const notes: string[] = [];
    const collect = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && entry.name.endsWith(".md")) notes.push(full);
      }
    };
    collect(planned.courseDir);
    collect(planned.extrasDir);

    for (const note of notes) {
      try {
        const before = fs.readFileSync(note, "utf-8");
        const after = rewriteInternalLinks(before, links, path.dirname(note));
        for (const ref of after.unresolvedPages) {
          pendingPages.set(`${ref.courseId}:${ref.slug.toLowerCase()}`, ref);
        }
        for (const ref of after.unresolvedFiles) {
          pendingFiles.set(`${ref.courseId}:${ref.fileId}`, ref);
        }
        if (after.rewritten > 0 && after.markdown !== before) {
          fs.writeFileSync(note, after.markdown, "utf-8");
          t.linksRewritten += after.rewritten;
        }
      } catch (err) {
        log.warn(`[links] Could not re-link ${path.basename(note)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/**
 * One summary block, used for both a single course and the run total.
 *
 * `skipZeros` is for the per-course sections: printing every zero line once per
 * course buries the numbers that actually moved. The total always prints in
 * full, so the shape of the summary doesn't change run to run.
 */
export function printTally(
  t: Tally,
  opts: { incremental: boolean; prune: boolean; skipZeros?: boolean; indent?: string },
): void {
  const skipZeros = opts.skipZeros ?? false;
  const indent = opts.indent ?? "  ";
  let printed = 0;

  const line = (label: string, value: number, text?: string): void => {
    if (skipZeros && value === 0) return;
    printed += 1;
    console.log(`${indent}${`${label}:`.padEnd(20)}${text ?? value}`);
  };

  line("Pages", t.pages);
  line("Assignments", t.assignments, `${t.assignments} (with rubrics: ${t.rubrics})`);
  line("Quizzes", t.quizzes, `${t.quizzes} (questions captured: ${t.quizQuestions})`);
  line("Discussions", t.discussions);
  line(
    "Files downloaded",
    t.filesDownloaded,
    `${t.filesDownloaded} (converted to .md: ${t.filesConverted})`,
  );
  line(
    "SharePoint",
    t.sharepointDownloaded + t.sharepointConverted + t.sharepointFallbackLinks,
    `${t.sharepointDownloaded} downloaded, ${t.sharepointConverted} converted, ${t.sharepointFallbackLinks} link-only`,
  );
  line("External links", t.links);
  line(
    "Outside modules",
    t.syllabi + t.announcements + t.unfiledPages + t.unfiledFiles,
    `${t.syllabi} syllabus, ${t.announcements} announcements, ${t.unfiledPages} unfiled pages, ${t.unfiledFiles} unfiled files`,
  );
  line("Linked-only pages", t.linkedPages, `${t.linkedPages} (found by following links)`);
  line(
    "Linked files",
    t.linkedFiles,
    `${t.linkedFiles} downloaded, ${t.linkedFilesConverted} converted to .md`,
  );
  line("Images localised", t.assetsLocalised);
  line("Internal links", t.linksRewritten, `${t.linksRewritten} rewritten`);
  line("SubHeaders skipped", t.subheadersSkipped);
  line("Unchanged, skipped", t.skipped, `${t.skipped}${opts.incremental ? "" : " (incremental off)"}`);
  if (opts.prune) {
    line("Orphans removed", t.orphansRemoved);
  } else {
    line("Orphans found", t.orphansFound, `${t.orphansFound} (run with --prune to remove)`);
  }
  if (t.prunesHeldBack) {
    line("Cleanup held back", t.prunesHeldBack, `${t.prunesHeldBack} module(s) with unresolved items`);
  }
  line("Errors", t.errors);

  // Only reachable with skipZeros: a course where nothing changed at all.
  if (printed === 0) console.log(`${indent}(no changes)`);
}

// main walk

export async function scrapeAll(
  opts: { force?: boolean; prune?: boolean; noPrune?: boolean } = {},
): Promise<void> {
  // Opens the login window first if the saved session has lapsed.
  await ensureCanvasSession();
  const api = await makeCanvasContext();
  const manifest = loadManifest();
  const incremental = CONFIG.scrape.incremental && !opts.force;
  // --no-prune always wins, so there's a way to inspect before deleting.
  const prune = (CONFIG.scrape.pruneOrphans || Boolean(opts.prune)) && !opts.noPrune;
  /** One tally per course id, summed into the run total for the summary. */
  const tallies = new Map<number, Tally>();

  try {
    const courses = await getScrapeCourses(api);
    log.info(`Scraping ${courses.length} course(s): ${courses.map((c) => c.course_code).join(", ")}`);
    log.info(`Output root: ${CONFIG.paths.output}`);
    log.info(
      `Incremental: ${incremental ? "on" : "off"} | Orphans: ${prune ? "prune" : "report only"} | ` +
        `Internal links: ${CONFIG.scrape.linkInternally ? "on" : "off"}`,
    );

    const links: LinkIndex = new Map();
    const pending = new Map<string, PageRef>();
    const pendingFiles = new Map<string, FileRef>();
    const plan = await planRun(api, courses, links);
    log.info(`Planned ${plan.reduce((n, p) => n + p.modules.length, 0)} module(s), ${links.size} link target(s)\n`);

    for (const planned of plan) {
      const { course, courseDir } = planned;
      const t = tallyFor(tallies, course.id);
      log.info(`Course ${course.course_code} -> ${courseDir}`);

      const visitedModuleDirs = new Set<string>();
      let courseIssues = 0;

      for (const mod of planned.modules) {
        const modState: ModuleState = { dir: mod.dir, keep: new Set<string>(), issues: 0 };
        visitedModuleDirs.add(path.resolve(mod.dir).toLowerCase());

        for (const { item, num, mdDest } of mod.items) {
          const c: ItemCtx = {
            api,
            course,
            moduleName: mod.moduleName,
            item,
            num,
            mod: modState,
            mdDest,
            t,
            manifest,
            incremental,
            links,
            pending,
            pendingFiles,
            moduleFileIds: planned.fileIds,
          };
          try {
            switch (item.type) {
              case "Page":
                await handlePage(c);
                break;
              case "Assignment":
                await handleAssignment(c);
                break;
              case "Quiz":
                await handleQuiz(c);
                break;
              case "Discussion":
                await handleDiscussion(c);
                break;
              case "File":
                await handleFile(c);
                break;
              case "ExternalTool":
                handleExternalTool(c);
                break;
              case "ExternalUrl":
                if (hostOf(item.external_url).includes("sharepoint")) {
                  await handleSharePoint(c);
                } else {
                  handleExternalUrl(c);
                }
                break;
              case "SubHeader":
                t.subheadersSkipped += 1;
                break;
              default:
                markIssue(c);
                log.warn(`[item] Unhandled type "${item.type}" — "${item.title}" skipped.`);
            }
          } catch (err) {
            markIssue(c);
            t.errors += 1;
            log.error(
              `[item] Failed on "${item.title}" (${item.type}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        courseIssues += modState.issues;
        sweepModule(modState, prune, t);
      }

      sweepCourse(courseDir, visitedModuleDirs, courseIssues, prune, t);

      // Everything outside the modules: syllabus, announcements, unfiled pages
      // and files. Failure-isolated per section inside scrapeExtras.
      const extras = await scrapeExtras({
        api,
        course,
        dir: planned.extrasDir,
        modulePageSlugs: planned.pageSlugs,
        moduleFileIds: planned.fileIds,
      });
      t.syllabi += extras.syllabus;
      t.announcements += extras.announcements;
      t.unfiledPages += extras.unfiledPages;
      t.unfiledFiles += extras.unfiledFiles;
      t.assetsLocalised += extras.assetsLocalised;
      t.errors += extras.errors;
    }

    // Pages and files reachable only by following links, then a final pass so
    // every note on disk points at them (including ones written before they
    // were found).
    if (CONFIG.scrape.linkInternally) {
      const byCourseId = new Map(plan.map((p) => [String(p.course.id), p]));
      // Sweep disk first: on an incremental run the note holding a link is
      // skipped, so links must be discovered from what's already written.
      resolveLinksOnDisk(plan, links, tallies, pending, pendingFiles);
      await fetchLinkedPages(api, pending, byCourseId, links, tallies, pendingFiles);
      await fetchLinkedFiles(api, pendingFiles, byCourseId, links, tallies);
      resolveLinksOnDisk(plan, links, tallies, pending, pendingFiles);
    }

    console.log("");
    log.info("Done. Summary:");

    // Course order follows the scrape order, so the summary reads in the same
    // order as the log above it.
    const total = newTally();
    for (const planned of plan) {
      const t = tallies.get(planned.course.id);
      if (!t) continue;
      addTally(total, t);
      console.log(`\n  ${planned.course.course_code ?? `Course ${planned.course.id}`}`);
      printTally(t, { incremental, prune, skipZeros: true, indent: "    " });
    }

    console.log(`\n  All courses`);
    printTally(total, { incremental, prune, indent: "    " });
  } finally {
    saveManifest(manifest);
    await api.dispose().catch(() => {});
  }
}
