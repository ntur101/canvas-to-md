/** Tiny timestamped console logger. Kept deliberately minimal. */

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string): void {
    console.log(`[${stamp()}] [INFO] ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`[${stamp()}] [WARN] ${msg}`);
  },
  error(msg: string): void {
    console.error(`[${stamp()}] [ERROR] ${msg}`);
  },
};
