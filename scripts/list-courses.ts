/**
 * npm run courses — list your active courses with your role and their term,
 * and flag the ones worth scraping: courses you're a *student* in whose term is
 * current (contains today's date), plus any added via `scrape.extraCourseIds`.
 *
 * This is how you'll pick which courses the scraper targets — observer courses,
 * inductions and finished papers all fall away here.
 */

import { makeCanvasContext, canvasGet, type CanvasCourse } from "../src/canvasApi.js";
import { roles, isExtra, inScrapeSet } from "../src/courses.js";
import { log } from "../src/logger.js";

async function main(): Promise<void> {
  const ctx = await makeCanvasContext();
  try {
    const { data: courses } = await canvasGet<CanvasCourse[]>(
      ctx,
      "/api/v1/courses?enrollment_state=active&include[]=term&include[]=enrollments&per_page=100",
    );

    const now = Date.now();
    const rows = courses
      .map((c) => ({
        c,
        role: roles(c).join("+") || "(none)",
        term: c.term?.name ?? "(no term)",
        keep: inScrapeSet(c, now),
      }))
      .sort((a, b) => Number(b.keep) - Number(a.keep));

    log.info(`${courses.length} active course(s). ✅ = student + current term, or added via scrape.extraCourseIds (the scrape set):\n`);
    for (const { c, role, term, keep } of rows) {
      const mark = keep ? "✅" : "  ";
      console.log(`${mark} [${c.id}] ${c.course_code ?? "(no code)"}`);
      console.log(`      ${c.name ?? "(no name)"}`);
      console.log(`      role: ${role}   term: ${term}${isExtra(c) ? "   (added via scrape.extraCourseIds)" : ""}`);
    }

    const keep = rows.filter((r) => r.keep);
    console.log("");
    log.info(`Scrape set (${keep.length}): ${keep.map((r) => r.c.course_code ?? r.c.id).join(", ")}`);
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
