/**
 * Talk to the Canvas REST API using the saved browser session.
 *
 * We authenticate with the SSO session cookie, not an access token — UoA has
 * personal access tokens disabled, but Canvas's own front-end calls /api/v1/
 * with nothing but the session cookie, and so can we (for GETs; writes would
 * additionally need the CSRF header, which we never do).
 *
 * The one non-obvious wrinkle: when you authenticate by session cookie rather
 * than a Bearer token, Canvas prepends `while(1);` to JSON responses as
 * anti-JSON-hijacking protection. It must be stripped before parsing. With a
 * token you'd never see it — which is exactly why it's easy to get caught out.
 */

import fs from "node:fs";
import { request, type APIRequestContext, type APIResponse } from "playwright";
import { CONFIG } from "../config.js";
import { withRetry, TransientError, isTransientStatus, parseRetryAfter } from "./retry.js";

const WHILE1_PREFIX = /^while\(1\);/;

export interface CanvasTerm {
  id: number;
  name?: string;
  start_at?: string | null;
  end_at?: string | null;
}

export interface CanvasEnrollment {
  /** "student" | "teacher" | "ta" | "observer" | "designer" */
  type?: string;
  role?: string;
  /** "active" | "invited" | "completed" | ... */
  enrollment_state?: string;
}

export interface CanvasCourse {
  id: number;
  name?: string;
  course_code?: string;
  enrollment_term_id?: number;
  workflow_state?: string;
  /** Present when requested with include[]=syllabus_body. HTML. */
  syllabus_body?: string | null;
  /** Present when requested with include[]=term. */
  term?: CanvasTerm;
  /** Present when requested with include[]=enrollments — scoped to you. */
  enrollments?: CanvasEnrollment[];
}

export interface CanvasModuleItem {
  id: number;
  title?: string;
  position?: number;
  indent?: number;
  /** File | Page | Discussion | Assignment | Quiz | SubHeader | ExternalUrl | ExternalTool */
  type?: string;
  content_id?: number;
  html_url?: string;
  url?: string;
  page_url?: string;
  external_url?: string;
}

export interface CanvasModule {
  id: number;
  name?: string;
  position?: number;
  items_count?: number;
  items?: CanvasModuleItem[];
}

export interface CanvasPage {
  title?: string;
  body?: string | null;
  html_url?: string;
  updated_at?: string;
}

/** One rating band of a rubric criterion ("Excellent — 5 pts"). */
export interface CanvasRubricRating {
  description?: string;
  long_description?: string;
  points?: number;
}

/** One row of a rubric: the criterion and its rating bands. */
export interface CanvasRubricCriterion {
  description?: string;
  long_description?: string;
  points?: number;
  ratings?: CanvasRubricRating[];
}

export interface CanvasAssignment {
  name?: string;
  description?: string | null;
  html_url?: string;
  due_at?: string | null;
  points_possible?: number | null;
  updated_at?: string;
  /** Present when the assignment has a rubric attached. */
  rubric?: CanvasRubricCriterion[];
}

/** A page as it appears in the course-wide pages listing. */
export interface CanvasPageSummary {
  /** The slug used in /pages/<url>. */
  url?: string;
  title?: string;
  html_url?: string;
  updated_at?: string;
  published?: boolean;
}

export interface CanvasQuizAnswer {
  text?: string;
  html?: string;
}

export interface CanvasQuizQuestion {
  id?: number;
  question_name?: string;
  /** HTML. */
  question_text?: string;
  question_type?: string;
  points_possible?: number;
  position?: number;
  answers?: CanvasQuizAnswer[];
}

export interface CanvasQuiz {
  title?: string;
  description?: string | null;
  html_url?: string;
  due_at?: string | null;
  points_possible?: number | null;
  updated_at?: string;
}

export interface CanvasDiscussion {
  title?: string;
  /** The topic body as HTML — the prompt, not the replies. */
  message?: string | null;
  html_url?: string;
  posted_at?: string | null;
  updated_at?: string;
}

export interface CanvasFile {
  id: number;
  display_name?: string;
  filename?: string;
  /** Signed download URL (works with the session context). */
  url?: string;
  "content-type"?: string;
  size?: number;
  updated_at?: string;
}

/** Build a cookies-only request context from the saved Canvas session. */
export async function makeCanvasContext(): Promise<APIRequestContext> {
  if (!fs.existsSync(CONFIG.paths.storageState)) {
    throw new Error(
      `No saved Canvas session at ${CONFIG.paths.storageState}. Run: npm run setup-auth`,
    );
  }
  return request.newContext({
    baseURL: CONFIG.canvas.baseUrl,
    storageState: CONFIG.paths.storageState,
    extraHTTPHeaders: {
      // Ask for JSON and look like the front-end's own XHR calls.
      Accept: "application/json+canvas-string-ids, application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
}

/** Parse a Canvas JSON body, stripping the session-auth `while(1);` guard. */
function parseCanvasJson<T>(raw: string): T {
  return JSON.parse(raw.replace(WHILE1_PREFIX, "")) as T;
}

/**
 * GET a Canvas API path and return the parsed JSON.
 *
 * `pathAndQuery` is everything after the host, e.g.
 * "/api/v1/courses?enrollment_state=active&per_page=100".
 *
 * Throws with a readable message on a non-2xx response or a body that isn't the
 * JSON we asked for (usually the SSO login page — the session has expired).
 *
 * Rate limits and 5xx blips are retried with backoff; a bad session or a missing
 * resource is not, since neither improves on a second attempt.
 */
export async function canvasGet<T>(
  ctx: APIRequestContext,
  pathAndQuery: string,
): Promise<{ data: T; res: APIResponse }> {
  return withRetry(`GET ${pathAndQuery}`, async () => {
    const res = await ctx.get(pathAndQuery, { timeout: CONFIG.canvas.requestTimeout });
    const body = await res.text();

    if (!res.ok()) {
      const message =
        `GET ${pathAndQuery} → HTTP ${res.status()} ${res.statusText()}\n` + body.slice(0, 300);
      if (isTransientStatus(res.status())) {
        throw new TransientError(message, parseRetryAfter(res.headers()["retry-after"]));
      }
      throw new Error(message);
    }

    const contentType = res.headers()["content-type"] ?? "";
    if (!contentType.includes("json")) {
      throw new Error(
        `GET ${pathAndQuery} returned ${contentType || "no content-type"}, not JSON — ` +
          `the session is probably invalid or API-via-session is disabled. ` +
          `Try: npm run setup-auth\nFirst bytes: ${body.slice(0, 120)}`,
      );
    }

    try {
      return { data: parseCanvasJson<T>(body), res };
    } catch (err) {
      throw new Error(
        `GET ${pathAndQuery} returned a body that wasn't parseable JSON: ` +
          `${err instanceof Error ? err.message : String(err)}\nFirst bytes: ${body.slice(0, 120)}`,
      );
    }
  });
}

/** Pull the rel="next" URL out of a Canvas Link header, or null when there's none. */
function nextLink(linkHeader: string | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * GET a Canvas list endpoint and follow pagination to the end, concatenating
 * every page into one array. Each page is expected to be a JSON array.
 */
export async function canvasGetAll<T>(
  ctx: APIRequestContext,
  pathAndQuery: string,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = pathAndQuery;
  while (url) {
    const { data, res } = await canvasGet<T[]>(ctx, url);
    if (!Array.isArray(data)) {
      throw new Error(`Expected a JSON array from ${url}, got: ${JSON.stringify(data).slice(0, 160)}`);
    }
    out.push(...data);
    url = nextLink(res.headers()["link"]);
  }
  return out;
}
