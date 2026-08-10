/** npm run setup-auth-sharepoint — sign in to SharePoint once and save the session. */

import { setupSharePointAuth } from "../src/sharepoint.js";
import { log } from "../src/logger.js";

setupSharePointAuth().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
