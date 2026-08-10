/**
 * Central config for the UoA Canvas scraper.
 *
 * __dirname is derived from import.meta.url (this is an ESM project), so paths
 * resolve relative to this file the same way UniNotes does it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyUserSettings } from "./src/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The defaults, in reviewable source. Chosen to be safe on a machine that has
 * just cloned this: output goes to a local folder inside the project and nothing
 * is ever deleted. Point them at a vault — and turn pruning on — in a gitignored
 * settings.json (see src/settings.ts), not here.
 */
export const DEFAULTS = {
  canvas: {
    /**
     * Scheme + host only. Every API path is built onto this in src/canvasApi.ts.
     * UoA's Canvas is canvas.auckland.ac.nz; the SSO redirect to Microsoft is
     * handled by the browser during setup-auth.
     */
    baseUrl: "https://canvas.auckland.ac.nz",
    /** How long a single API request may take before we give up. */
    requestTimeout: 30_000,
  },

  retry: {
    /** Total tries per request, not retries after the first (so 3 = 1 + 2 more). */
    attempts: 3,
    /** First backoff; doubles each attempt, plus jitter. */
    baseDelayMs: 1_000,
    /** Ceiling on the computed backoff. */
    maxDelayMs: 15_000,
    /** Ceiling on an honoured Retry-After, so a wild value can't stall the run. */
    maxRetryAfterMs: 60_000,
  },

  sharepoint: {
    /** Landing page for the auth flow; SSO redirects through Microsoft from here. */
    home: "https://uoa-my.sharepoint.com",
    /** How long a file download may take (decks can be large). */
    downloadTimeout: 120_000,
    /** How long setup-auth-sharepoint waits for you to finish the SSO login. */
    authLoginTimeout: 5 * 60_000,
  },

  browser: {
    /** Reuse the Edge channel — same browser UniNotes signs in through. */
    channel: "msedge" as const,
    /**
     * setup-auth must be headed so you can complete Microsoft SSO by hand.
     * Everything after auth is pure HTTP against the saved session, no window.
     */
    navigationTimeout: 60_000,
    /** How long setup-auth waits for you to finish the SSO login, in ms. */
    authLoginTimeout: 5 * 60_000,
  },

  paths: {
    /**
     * The signed-in Canvas session. Separate file from UniNotes' Panopto
     * session: same Microsoft SSO, but the cookies are scoped to
     * canvas.auckland.ac.nz, so it needs its own login.
     */
    storageState: path.join(__dirname, "browser-data", "storage-state.json"),
    /**
     * Separate signed-in session for SharePoint/OneDrive (uoa-my.sharepoint.com).
     * A different domain from Canvas with its own cookies, so it needs its own
     * login — run `npm run setup-auth-sharepoint`. Seeding from the Canvas session
     * cuts the click-through but does not remove the manual SSO step.
     */
    sharepointStorageState: path.join(__dirname, "browser-data", "storage-state-sharepoint.json"),
    /**
     * Where scraped content is written. Defaults to a local Output/ folder
     * inside the project (gitignored) so a fresh clone never writes outside
     * itself. To file straight into an Obsidian vault instead, set
     * "paths.output" in settings.json — this is the tree orphan pruning deletes
     * inside, so it is deliberately not a vault by default.
     */
    output: path.join(__dirname, "Output"),
    /**
     * Cache of each item's last-seen `updated_at`, used for incremental scrapes.
     * Lives in the repo, not the vault — delete it to force a full re-scrape.
     */
    manifest: path.join(__dirname, "state", "manifest.json"),
  },

  scrape: {
    /**
     * Subfolder created inside each course folder for the Canvas module dump —
     * sits next to UniNotes' LectureNotes and your curated notes.
     */
    subfolder: "Modules",
    /**
     * Exceptions only. A course code Canvas returns space-separated
     * ("COMPSYS 726") becomes its folder under the output root by replacing
     * spaces with hyphens ("COMPSYS-726"), which is the usual vault convention —
     * add an entry here (or in settings.json) only for a course whose folder
     * doesn't follow that rule.
     */
    courseFolders: {} as Record<string, string>,
    /** Keep the original PDF alongside its extracted-text .md (your choice). */
    keepOriginalPdf: true,
    /**
     * Skip re-downloading/re-converting a Page/Assignment/Quiz/File whose Canvas
     * `updated_at` matches the last run (and whose output still exists on disk).
     * SharePoint items have no cheap `updated_at` from Canvas, so they're instead
     * skipped by file existence — once downloaded, a deck is only re-fetched if
     * its local copy is deleted. Override for one run with `npm run dev:force`.
     */
    incremental: true,
    /**
     * Delete files in a module folder that this run didn't produce — the leftovers
     * from items renamed, reordered, or removed on Canvas.
     *
     * Off by default: this deletes real files, and a fresh clone has no way to
     * know the output root holds nothing hand-written. Turn it on in
     * settings.json once everything under the output root is generated — then a
     * file this run didn't produce is by definition stale. `npm run dev:no-prune`
     * always wins for a single run, and `--prune` forces it on for one run.
     *
     * Only files at the top level of a module folder are ever considered, so
     * `assets/` is untouched, and `Course Info/` is outside the sweep entirely.
     * Pruning is skipped for any module (or whole course) where an item errored,
     * so a transient failure can never be mistaken for "removed from Canvas".
     */
    pruneOrphans: false,
    /**
     * Rewrite links between scraped items into Obsidian links, so the vault is
     * navigable and the graph reflects the course. Links to anything not
     * scraped stay as plain URLs.
     */
    linkInternally: true,
    /**
     * How many rounds to follow links to pages that aren't in any module. A
     * course with its Pages tab disabled 404s the pages listing, so following
     * links is the only way to reach that content; each round can discover more.
     */
    linkedPageRounds: 3,
    /** Include assignment rubrics and quiz questions where Canvas exposes them. */
    includeRubrics: true,
    includeQuizQuestions: true,
  },

  /**
   * Course content that lives outside the module structure. Written to a sibling
   * of the modules folder (never inside it — orphan pruning treats unrecognised
   * folders under the modules root as removed-from-Canvas).
   */
  extras: {
    folder: "Course Info",
    /** The syllabus page — often where the real schedule and policies live. */
    syllabus: true,
    /** Announcements, where deadline changes and errata usually land. */
    announcements: true,
    /** Pages that exist in the course but aren't linked from any module. */
    unfiledPages: true,
    /**
     * Files in the course's Files area not attached to any module. Off by
     * default: it can be a large download of material that was never assigned.
     */
    unfiledFiles: false,
  },
} as const;

/**
 * What this run uses: the defaults above with settings.json merged over the top.
 * Read once at import, so every module sees the same values for the whole run.
 */
export const CONFIG = applyUserSettings(DEFAULTS);
