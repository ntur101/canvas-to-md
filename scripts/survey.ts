/**
 * npm run survey — read-only inventory of what's actually in the target courses.
 *
 * Walks every module and item across the scrape set and reports the shape of the
 * problem: how many of each item type, which file extensions, and which external
 * hosts (so SharePoint/OneDrive links show up). This is what decides which
 * converters get built first — no conversion or downloading happens here.
 */

import {
  makeCanvasContext,
  canvasGetAll,
  type CanvasModule,
  type CanvasModuleItem,
} from "../src/canvasApi.js";
import { getScrapeCourses } from "../src/courses.js";
import { log } from "../src/logger.js";

function tally(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Print a count map, biggest first, indented. */
function printTally(map: Map<string, number>, indent = "    "): void {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    console.log(`${indent}(none)`);
    return;
  }
  for (const [k, n] of rows) console.log(`${indent}${String(n).padStart(4)}  ${k}`);
}

/** Best-effort file extension from an item title, e.g. "Lecture 3.pptx" → "pptx". */
function extFromTitle(title: string | undefined): string {
  const m = (title ?? "").match(/\.([a-z0-9]{1,6})$/i);
  return m ? m[1].toLowerCase() : "(no extension)";
}

function hostOf(url: string | undefined): string {
  if (!url) return "(no url)";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "(unparseable)";
  }
}

async function main(): Promise<void> {
  const ctx = await makeCanvasContext();
  try {
    const courses = await getScrapeCourses(ctx);
    log.info(`Surveying ${courses.length} course(s): ${courses.map((c) => c.course_code).join(", ")}\n`);

    // Global rollups across all courses.
    const typeTotals = new Map<string, number>();
    const extTotals = new Map<string, number>();
    const hostTotals = new Map<string, number>();
    let grandItems = 0;

    for (const course of courses) {
      const modules = await canvasGetAll<CanvasModule>(
        ctx,
        `/api/v1/courses/${course.id}/modules?per_page=100`,
      );

      console.log(`━━ ${course.course_code} — ${course.name ?? ""}`);
      console.log(`   ${modules.length} module(s)`);

      const courseTypes = new Map<string, number>();
      let courseItems = 0;

      for (const mod of modules) {
        const items = await canvasGetAll<CanvasModuleItem>(
          ctx,
          `/api/v1/courses/${course.id}/modules/${mod.id}/items?per_page=100`,
        );
        courseItems += items.length;

        for (const it of items) {
          const type = it.type ?? "(untyped)";
          tally(courseTypes, type);
          tally(typeTotals, type);
          grandItems += 1;

          if (type === "File") tally(extTotals, extFromTitle(it.title));
          if (type === "ExternalUrl" || type === "ExternalTool") {
            tally(hostTotals, hostOf(it.external_url));
          }
        }
      }

      console.log(`   ${courseItems} item(s), by type:`);
      printTally(courseTypes, "      ");
      console.log("");
    }

    console.log("═══════════════════════════════════════════");
    log.info(`TOTAL across ${courses.length} course(s): ${grandItems} items`);
    console.log("\nItem types:");
    printTally(typeTotals);
    console.log("\nFile extensions (File items):");
    printTally(extTotals);
    console.log("\nExternal hosts (ExternalUrl/ExternalTool items):");
    printTally(hostTotals);
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
