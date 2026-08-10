// Minimal declarations for dependencies that ship no types.

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}

declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export = pdfParse;
}
