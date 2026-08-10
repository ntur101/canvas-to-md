/**
 * npm run dev — download all module content for the target courses.
 *
 * Flags:
 *   --force      ignore the incremental cache; re-fetch and re-convert everything
 *   --no-prune   list orphaned files instead of deleting them (deleting is the default)
 *   --prune      force pruning on when it's been disabled in config
 */

import { scrapeAll } from "../src/scrape.js";
import { log } from "../src/logger.js";

const force = process.argv.includes("--force");
const prune = process.argv.includes("--prune");
const noPrune = process.argv.includes("--no-prune");

scrapeAll({ force, prune, noPrune }).catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
