/**
 * Canvas login: open Edge, let you complete the university SSO by hand, then
 * save the resulting canvas.auckland.ac.nz session to disk.
 *
 * Mirrors UniNotes' Panopto auth flow, but lands on and saves the Canvas
 * session instead. Headed by necessity — SSO can't be automated safely.
 *
 * The session can't be made to last: Canvas's cookie has no expiry of its own
 * and UoA ends it server-side within about a day, along with the sign-in page's
 * own session. So instead a run checks it first (ensureCanvasSession) and opens
 * this login itself when it has lapsed. The window runs in a persistent Edge
 * profile, so what the sign-in page remembers about this device (its MFA
 * cookie lasts a year) carries over and a re-login is quicker than a fresh one.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium, request, type BrowserContext } from "playwright";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";

const SELF = "/api/v1/users/self";
const JSON_HEADERS = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };

/** True once the browser has settled on a real Canvas page, past the SSO chain. */
function isOnCanvas(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = new URL(CONFIG.canvas.baseUrl).hostname;
  if (parsed.hostname !== host) return false;
  // /login/... is the Canvas-side SSO handoff, not a signed-in page yet.
  return !parsed.pathname.startsWith("/login");
}

/**
 * The first time the persistent profile is created, carry over the cookies of
 * an earlier saved session. That brings the sign-in page's remembered-device
 * cookie with it, so the first login in the new profile needn't repeat MFA.
 */
async function seedProfile(context: BrowserContext): Promise<void> {
  try {
    const state = JSON.parse(fs.readFileSync(CONFIG.paths.storageState, "utf-8")) as {
      cookies?: Parameters<BrowserContext["addCookies"]>[0];
    };
    if (state.cookies?.length) await context.addCookies(state.cookies);
  } catch {
    // No earlier session, or unreadable: start the profile empty.
  }
}

export async function setupAuth(): Promise<void> {
  log.info("Opening Canvas for manual SSO login...");
  const fresh = !fs.existsSync(CONFIG.paths.browserProfile);
  const context = await chromium.launchPersistentContext(CONFIG.paths.browserProfile, {
    channel: CONFIG.browser.channel,
    headless: false,
  });
  if (fresh) await seedProfile(context);
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(CONFIG.canvas.baseUrl, { timeout: CONFIG.browser.navigationTimeout });
  log.info(
    "Complete the university SSO login in the browser window. " +
      "The session saves automatically once you land on Canvas, and the window closes itself.",
  );

  const deadline = Date.now() + CONFIG.browser.authLoginTimeout;
  let saved = false;
  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) break;
      if (isOnCanvas(page.url())) {
        // Confirm the session actually works before trusting it: hit an endpoint
        // that only returns JSON when authenticated.
        const probe = await page.request
          .get(`${CONFIG.canvas.baseUrl}${SELF}`, { timeout: CONFIG.canvas.requestTimeout, headers: JSON_HEADERS })
          .catch(() => null);
        if (probe && probe.ok()) {
          const state = await context.storageState();
          fs.mkdirSync(path.dirname(CONFIG.paths.storageState), { recursive: true });
          fs.writeFileSync(CONFIG.paths.storageState, JSON.stringify(state, null, 2));
          log.info(`Canvas session saved to ${CONFIG.paths.storageState}`);
          saved = true;
          break;
        }
      }
      await page.waitForTimeout(2000);
    }
  } catch {
    // The window was closed mid-login; reported below.
  }

  await context.close().catch(() => {});
  if (!saved) {
    throw new Error(
      "No signed-in Canvas session (the login timed out or the window was closed). Re-run: npm run setup-auth",
    );
  }
}

/** Whether the saved Canvas session still works, checked with one cheap API call. */
export async function canvasSessionValid(): Promise<boolean> {
  if (!fs.existsSync(CONFIG.paths.storageState)) return false;
  const ctx = await request.newContext({ baseURL: CONFIG.canvas.baseUrl, storageState: CONFIG.paths.storageState });
  try {
    const res = await ctx.get(SELF, { timeout: CONFIG.canvas.requestTimeout, headers: JSON_HEADERS, maxRedirects: 0 });
    // An expired session gets a 401, or a redirect/HTML login page instead of JSON.
    return res.ok() && (res.headers()["content-type"] ?? "").includes("json");
  } catch {
    return false;
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

/**
 * Make sure there's a working Canvas session before a run starts. When it has
 * lapsed, open the login window (browser.autoLogin) and continue once you're
 * signed in; with autoLogin off, fail with the command to run instead.
 */
export async function ensureCanvasSession(): Promise<void> {
  if (await canvasSessionValid()) return;
  if (!CONFIG.browser.autoLogin) {
    throw new Error("The saved Canvas session has expired. Sign in again: npm run setup-auth");
  }
  log.warn("The saved Canvas session has expired; opening the login window. Sign in and the run will carry on.");
  await setupAuth();
  if (!(await canvasSessionValid())) {
    throw new Error("Signed in, but the new Canvas session still doesn't work. Try: npm run setup-auth");
  }
}
