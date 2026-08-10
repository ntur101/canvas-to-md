/**
 * Internal Canvas links -> Obsidian links.
 *
 * A scraped page is full of links to other Canvas pages, assignments and quizzes
 * that are themselves in the vault. Left as https:// URLs they bounce you out to
 * a browser and the notes stay a flat pile; rewritten, the vault becomes
 * navigable and Obsidian's graph reflects the real course structure.
 *
 * The index has to be built before any note is written, because a link can point
 * forward to a page in a later module (or another course) — so src/scrape.ts
 * plans the whole run first, then processes.
 *
 * Links to things that weren't scraped are deliberately left as URLs: a dead
 * wikilink is worse than a working external link.
 *
 * Files get the same treatment as pages: a Canvas file link found inside a
 * page/quiz/assignment body (as opposed to a File-type module item, which
 * src/scrape.ts's handleFile already downloads) is otherwise invisible — e.g. a
 * PDF attached inline to a Quiz's own description rather than as its own module
 * item. src/scrape.ts's fetchLinkedFiles follows these the same way
 * fetchLinkedPages follows unresolvedPages.
 */

import path from "node:path";
import { CONFIG } from "../config.js";

export interface LinkTarget {
  /** Note filename without .md — what a wikilink resolves against. */
  basename: string;
  /** Absolute path of the note, for the relative-link fallback. */
  fullPath: string;
}

export type LinkIndex = Map<string, LinkTarget>;

/**
 * Markdown links, excluding images. Two things it has to tolerate, both of which
 * Turndown emits from real Canvas HTML:
 *   - one level of nested brackets, for image-inside-link text: [![](img) T](url)
 *   - a title attribute: [text](url "Title") — from <a title="...">
 * Missing the title form silently skipped a large share of the internal links.
 */
const MD_LINK = /(?<!!)\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g;

export function pageKey(courseId: string | number, slug: string): string {
  return `page:${courseId}:${decodeURIComponent(slug).toLowerCase()}`;
}

export function contentKey(kind: string, courseId: string | number, contentId: string | number): string {
  return `${kind}:${courseId}:${contentId}`;
}

export function moduleItemKey(courseId: string | number, itemId: string | number): string {
  return `item:${courseId}:${itemId}`;
}

/** A Canvas page referenced by a link: enough to fetch it. */
export interface PageRef {
  courseId: string;
  slug: string;
}

/** The course + slug of a Canvas page URL, or null if it isn't one. */
export function parsePageRef(rawUrl: string): PageRef | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, CONFIG.canvas.baseUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== new URL(CONFIG.canvas.baseUrl).hostname.toLowerCase()) {
    return null;
  }
  const m = parsed.pathname.match(/\/courses\/(\d+)\/pages\/([^/?#]+)/);
  return m ? { courseId: m[1], slug: decodeURIComponent(m[2]) } : null;
}

/** A Canvas file referenced by a link: enough to fetch its metadata. */
export interface FileRef {
  courseId: string;
  fileId: string;
}

/**
 * The course + file id of a Canvas file URL, or null if it isn't one. Matches
 * both the /files/:id landing page and /files/:id/download — anything after
 * the id (path segment or query string) is ignored.
 */
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
  const m = parsed.pathname.match(/\/courses\/(\d+)\/files\/(\d+)/);
  return m ? { courseId: m[1], fileId: m[2] } : null;
}

/** The index key a Canvas URL refers to, or null if it isn't one we resolve. */
export function keyForUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, CONFIG.canvas.baseUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== new URL(CONFIG.canvas.baseUrl).hostname.toLowerCase()) {
    return null;
  }

  const p = parsed.pathname;
  let m = p.match(/\/courses\/(\d+)\/pages\/([^/?#]+)/);
  if (m) return pageKey(m[1], m[2]);

  m = p.match(/\/courses\/(\d+)\/modules\/items\/(\d+)/);
  if (m) return moduleItemKey(m[1], m[2]);

  m = p.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
  if (m) return contentKey("assignment", m[1], m[2]);

  m = p.match(/\/courses\/(\d+)\/quizzes\/(\d+)/);
  if (m) return contentKey("quiz", m[1], m[2]);

  m = p.match(/\/courses\/(\d+)\/discussion_topics\/(\d+)/);
  if (m) return contentKey("discussion", m[1], m[2]);

  m = p.match(/\/courses\/(\d+)\/files\/(\d+)/);
  if (m) return contentKey("file", m[1], m[2]);

  return null;
}

/** Relative POSIX path from a note's folder to another note. */
function relativeLink(fromDir: string, toFile: string): string {
  const rel = path.relative(fromDir, toFile).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export interface RewriteResult {
  markdown: string;
  rewritten: number;
  /**
   * Canvas pages linked from this body that aren't in the index — real course
   * content the module walk never reached. Courses with the Pages tab disabled
   * 404 the pages listing, so these links are the only way to discover them.
   */
  unresolvedPages: PageRef[];
  /**
   * Canvas files linked from this body that aren't in the index — either a file
   * attached inline to a page/quiz/assignment body rather than as its own File
   * module item, or (harmlessly) a File module item, which is never indexed
   * since its note name depends on a fetch (see planRun in src/scrape.ts).
   */
  unresolvedFiles: FileRef[];
}

/**
 * Point every internal Canvas link at the local note instead. Normally emits a
 * wikilink; when the link text contains an image (Canvas's card-style page
 * links do this) it emits a relative Markdown link instead, since a wikilink
 * alias would render the image markup as literal text.
 */
export function rewriteInternalLinks(
  markdown: string,
  index: LinkIndex,
  sourceDir: string,
): RewriteResult {
  let rewritten = 0;
  const unresolvedPages: PageRef[] = [];
  const unresolvedFiles: FileRef[] = [];

  const out = markdown.replace(MD_LINK, (whole, text: string, url: string, title: string | undefined) => {
    const key = keyForUrl(url);
    if (!key) return whole;
    const target = index.get(key);
    if (!target) {
      const page = parsePageRef(url);
      if (page) {
        unresolvedPages.push(page);
      } else {
        const file = parseFileRef(url);
        if (file) unresolvedFiles.push(file);
      }
      return whole;
    }

    rewritten += 1;
    const label = text.trim();

    if (label.includes("![")) {
      // Keep the title here — a Markdown link can carry one; a wikilink can't.
      return `[${text}](<${relativeLink(sourceDir, target.fullPath)}>${title ?? ""})`;
    }
    if (label === "" || label === target.basename) {
      return `[[${target.basename}]]`;
    }
    return `[[${target.basename}|${label}]]`;
  });

  return { markdown: out, rewritten, unresolvedPages, unresolvedFiles };
}
