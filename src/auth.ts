/**
 * One-time interactive login: open Edge, let you complete Microsoft SSO by hand,
 * then save the resulting canvas.auckland.ac.nz session to disk.
 *
 * Mirrors UniNotes' Panopto auth flow, but lands on and saves the Canvas
 * session instead. Headed by necessity — SSO can't be automated safely.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";

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

export async function setupAuth(): Promise<void> {
  log.info("Opening Canvas for manual SSO login...");
  const browser = await chromium.launch({ channel: CONFIG.browser.channel, headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CONFIG.canvas.baseUrl, { timeout: CONFIG.browser.navigationTimeout });
  log.info(
    "Complete the Microsoft SSO login in the browser window. " +
      "The session saves automatically once you land on Canvas — then you can close it.",
  );

  const deadline = Date.now() + CONFIG.browser.authLoginTimeout;
  let saved = false;
  while (Date.now() < deadline) {
    if (isOnCanvas(page.url())) {
      // Confirm the session actually works before trusting it: hit an endpoint
      // that only returns JSON when authenticated.
      const probe = await page
        .request.get(`${CONFIG.canvas.baseUrl}/api/v1/users/self`, {
          timeout: CONFIG.canvas.requestTimeout,
          headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        })
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

  await browser.close().catch(() => {});
  if (!saved) {
    throw new Error(
      "Timed out waiting for a signed-in Canvas session. Re-run: npm run setup-auth",
    );
  }
}
