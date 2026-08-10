/** npm run setup-auth — sign in to Canvas once and save the session. */

import { setupAuth } from "../src/auth.js";
import { log } from "../src/logger.js";

setupAuth().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
