/**
 * SharePoint/OneDrive access for the decks and docs behind ExternalUrl items.
 *
 * SharePoint is a different domain from Canvas with its own cookies, so it needs
 * its own signed-in session. setupSharePointAuth() runs a headed SSO login
 * (seeded from the Canvas session to cut clicks, but still manual). Once saved,
 * downloadSharePointFile() pulls a shared file with the download=1 trick, which
 * returns the raw bytes instead of the Office web viewer.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium, request, type APIRequestContext } from "playwright";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { withRetry, TransientError, isTransientStatus, parseRetryAfter } from "./retry.js";

const CANVAS_STATE = CONFIG.paths.storageState;
const SP_STATE = CONFIG.paths.sharepointStorageState;

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

/** Headed one-time SSO login for SharePoint. Saves the session for downloads. */
export async function setupSharePointAuth(): Promise<void> {
  log.info("Opening SharePoint for manual SSO login...");
  const browser = await chromium.launch({ channel: CONFIG.browser.channel, headless: false });
  // Seed with the Canvas session so the Microsoft SSO is fewer clicks.
  const context = await browser.newContext({
    storageState: fs.existsSync(CANVAS_STATE) ? CANVAS_STATE : undefined,
  });
  const page = await context.newPage();
  await page.goto(CONFIG.sharepoint.home, { timeout: CONFIG.browser.navigationTimeout }).catch(() => {});
  log.info("Complete the Microsoft SSO login if prompted. The session saves once you land on SharePoint.");

  const deadline = Date.now() + CONFIG.sharepoint.authLoginTimeout;
  let saved = false;
  while (Date.now() < deadline) {
    if (hostOf(page.url()).endsWith("sharepoint.com")) {
      // Give the page a moment to finish setting auth cookies, then save.
      await page.waitForTimeout(2500);
      fs.mkdirSync(path.dirname(SP_STATE), { recursive: true });
      await context.storageState({ path: SP_STATE });
      log.info(`SharePoint session saved to ${SP_STATE}`);
      saved = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  await browser.close().catch(() => {});
  if (!saved) throw new Error("Timed out waiting for a signed-in SharePoint session. Re-run: npm run setup-auth-sharepoint");
}

/** File type implied by the SharePoint sharing-link token (/:p:/, /:x:/, ...). */
function extFromShareToken(url: string): string {
  const m = url.match(/sharepoint\.com\/:([a-z]):\//i);
  const token = m?.[1]?.toLowerCase();
  switch (token) {
    case "p": return "pptx";
    case "x": return "xlsx";
    case "w": return "docx";
    case "b": return "pdf";
    default: return "";
  }
}

/** filename="..." out of a content-disposition header, if present. */
function filenameFromDisposition(disposition: string | undefined): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

export interface SharePointFile {
  buffer: Buffer;
  /** Real filename from the server when known (has the true extension). */
  filename: string | null;
  /** Extension (from the server filename, else the share-link token). */
  ext: string;
}

/**
 * Download a SharePoint shared file. Returns null (not throws) on any failure —
 * missing session, expired auth, an HTML interstitial instead of a file — so the
 * scrape falls back to recording the link and carries on.
 */
export async function downloadSharePointFile(shareUrl: string): Promise<SharePointFile | null> {
  if (!fs.existsSync(SP_STATE)) {
    log.warn("[sharepoint] No saved session — run: npm run setup-auth-sharepoint. Recording link only.");
    return null;
  }

  let ctx: APIRequestContext | null = null;
  try {
    const api = (ctx = await request.newContext({ storageState: SP_STATE }));
    const u = new URL(shareUrl);
    u.searchParams.set("download", "1");

    // Retry throttling/5xx here too — SharePoint throttles more readily than
    // Canvas, and a deck is expensive to give up on.
    const res = await withRetry(`sharepoint ${u.pathname}`, async () => {
      const r = await api.get(u.toString(), { timeout: CONFIG.sharepoint.downloadTimeout });
      if (isTransientStatus(r.status())) {
        throw new TransientError(
          `SharePoint returned HTTP ${r.status()}`,
          parseRetryAfter(r.headers()["retry-after"]),
        );
      }
      return r;
    });
    const contentType = res.headers()["content-type"] ?? "";
    const buffer = await res.body();

    // An HTML body means we got a login/interstitial page, not the file.
    if (!res.ok() || contentType.includes("text/html")) {
      log.warn(
        `[sharepoint] Download returned ${res.status()} ${contentType} (session likely expired). ` +
          "Re-run setup-auth-sharepoint. Recording link only.",
      );
      return null;
    }

    const filename = filenameFromDisposition(res.headers()["content-disposition"]);
    const ext = (filename ? filename.split(".").pop()?.toLowerCase() : "") || extFromShareToken(shareUrl);
    return { buffer, filename, ext };
  } catch (err) {
    log.warn(`[sharepoint] Download failed (${err instanceof Error ? err.message : String(err)}). Recording link only.`);
    return null;
  } finally {
    await ctx?.dispose().catch(() => {});
  }
}
