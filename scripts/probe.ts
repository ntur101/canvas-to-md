/**
 * npm run probe — the go/no-go check for the whole project.
 *
 * Confirms that the saved browser session can drive the Canvas REST API without
 * an access token. If this prints your courses, session auth works and the
 * scraper can be built on it. If it fails, we fall back to UI scraping instead.
 *
 * Hits two endpoints:
 *   /api/v1/users/self  — who am I (proves the session is valid)
 *   /api/v1/courses     — the list we'll iterate modules over
 */

import { makeCanvasContext, canvasGet, type CanvasCourse } from "../src/canvasApi.js";
import { log } from "../src/logger.js";

interface Self {
  id: number;
  name?: string;
  primary_email?: string;
  login_id?: string;
}

async function main(): Promise<void> {
  const ctx = await makeCanvasContext();
  try {
    const { data: self } = await canvasGet<Self>(ctx, "/api/v1/users/self");
    log.info(`Authenticated as: ${self.name ?? "(no name)"} (id ${self.id}${self.login_id ? `, ${self.login_id}` : ""})`);

    const { data: courses } = await canvasGet<CanvasCourse[]>(
      ctx,
      "/api/v1/courses?enrollment_state=active&per_page=100",
    );

    if (!Array.isArray(courses)) {
      log.warn(`Unexpected /courses shape: ${JSON.stringify(courses).slice(0, 200)}`);
      return;
    }

    log.info(`Found ${courses.length} active course(s):`);
    for (const c of courses) {
      const code = c.course_code ?? "(no code)";
      const name = c.name ?? "(no name)";
      console.log(`  [${c.id}] ${code} — ${name}`);
    }

    console.log("");
    log.info("Session-based API access WORKS. The scraper can be built on this. ✅");
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  console.log("");
  log.error(
    "Session-based API access did not work. If setup-auth succeeded, UoA may " +
      "restrict API-via-session — say the word and we'll switch this to UI scraping.",
  );
  process.exit(1);
});
