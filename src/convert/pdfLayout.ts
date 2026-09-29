/**
 * Page geometry for the PDF converter: finding bordered tables and assembling
 * text lines from positioned text items.
 *
 * A PDF has no notion of a table, only text drawn at coordinates and lines
 * drawn around it. pdf-parse ignored both (it only started a new line when the
 * vertical position changed), so a rubric's four columns came out one cell at a
 * time. Here the cell borders are read back out of the page's drawing
 * operators, rebuilt into a grid (the same idea as pdfplumber's "lattice"
 * mode), and each text item is dropped into the cell it sits in.
 *
 * Only tables with drawn borders are detected, which covers Word and
 * PowerPoint exports. Borderless tables fall back to ordinary lines of text.
 *
 * Coordinates are PDF user space: origin bottom-left, y grows upwards.
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

/** The fields of a pdf.js text item this module uses. */
export interface TextItem {
  str: string;
  /** [a, b, c, d, e, f]: (a, b) is the reading direction, (c, d) "up", (e, f) the origin. */
  transform: number[];
  width: number;
}

/** The fields of a pdf.js operator list this module uses. */
export interface OperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

/** Snap tolerance in points: borders closer than this are the same line. */
const TOL = 3;
/** A page with more cells than this is a diagram or chart, not a table. */
const MAX_CELLS = 600;

type Matrix = [number, number, number, number, number, number];
interface HEdge { y: number; x0: number; x1: number }
interface VEdge { x: number; y0: number; y1: number }

export interface Cell {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Page number, so a table continued across pages still orders its rows. */
  page: number;
  items: TextItem[];
}

export interface Table {
  cells: Cell[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// ---------- borders ----------

const multiply = (m: Matrix, n: number[]): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const PAINT_OPS = new Set<number>([
  OPS.fill, OPS.eoFill, OPS.stroke, OPS.closeStroke, OPS.fillStroke,
  OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);

/**
 * Horizontal and vertical border segments drawn on a page. Word/Acrobat draw
 * table borders as thin filled rectangles; other producers stroke lines. Both
 * count. Larger filled rectangles (cell shading, backgrounds) do not: Word
 * paints one behind every shaded line of text, which would otherwise slice a
 * cell into one row per line.
 */
function findEdges(ops: OperatorList): { h: HEdge[]; v: VEdge[] } {
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const h: HEdge[] = [];
  const v: VEdge[] = [];
  let pending: Array<[[number, number], [number, number]]> = [];

  const addSegment = ([ax, ay]: [number, number], [bx, by]: [number, number]): void => {
    const w = Math.abs(bx - ax);
    const hh = Math.abs(by - ay);
    if (hh <= TOL && w > TOL) h.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
    else if (w <= TOL && hh > TOL) v.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args[0])) ctm = multiply(ctm, args[0] as number[]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const [pathOps, coords] = args as [number[], number[]];
      let k = 0;
      let current: [number, number] | null = null;
      for (const op of pathOps) {
        if (op === OPS.rectangle) {
          const [x, y, w, hh] = coords.slice(k, k + 4);
          k += 4;
          // A rectangle counts as a border only when it's thin in one direction.
          const p = apply(ctm, x, y);
          const q = apply(ctm, x + w, y + hh);
          const width = Math.abs(q[0] - p[0]);
          const height = Math.abs(q[1] - p[1]);
          if (height <= TOL && width > TOL) pending.push([[p[0], (p[1] + q[1]) / 2], [q[0], (p[1] + q[1]) / 2]]);
          else if (width <= TOL && height > TOL) pending.push([[(p[0] + q[0]) / 2, p[1]], [(p[0] + q[0]) / 2, q[1]]]);
        } else if (op === OPS.moveTo) {
          current = apply(ctm, coords[k], coords[k + 1]);
          k += 2;
        } else if (op === OPS.lineTo) {
          const next = apply(ctm, coords[k], coords[k + 1]);
          k += 2;
          if (current) pending.push([current, next]);
          current = next;
        } else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    } else if (PAINT_OPS.has(fn)) {
      for (const [a, b] of pending) addSegment(a, b);
      pending = [];
    } else if (fn === OPS.endPath) pending = [];
  }
  return { h: mergeH(h), v: mergeV(v) };
}

/** Join collinear segments that touch or overlap into one. */
function mergeH(edges: HEdge[]): HEdge[] {
  const out: HEdge[] = [];
  for (const e of [...edges].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = out.find((o) => Math.abs(o.y - e.y) <= TOL && e.x0 <= o.x1 + TOL && e.x1 >= o.x0 - TOL);
    if (last) {
      last.x0 = Math.min(last.x0, e.x0);
      last.x1 = Math.max(last.x1, e.x1);
    } else out.push({ ...e });
  }
  return out;
}

function mergeV(edges: VEdge[]): VEdge[] {
  const out: VEdge[] = [];
  for (const e of [...edges].sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
    const last = out.find((o) => Math.abs(o.x - e.x) <= TOL && e.y0 <= o.y1 + TOL && e.y1 >= o.y0 - TOL);
    if (last) {
      last.y0 = Math.min(last.y0, e.y0);
      last.y1 = Math.max(last.y1, e.y1);
    } else out.push({ ...e });
  }
  return out;
}

// ---------- cells and tables ----------

/**
 * Smallest closed rectangles formed by the borders. From each border crossing
 * (as a top-left corner), walk down and right to the nearest crossings whose
 * connecting borders exist on all four sides.
 */
function findCells(h: HEdge[], v: VEdge[], page: number): Cell[] {
  const points: Array<{ x: number; y: number }> = [];
  for (const he of h) {
    for (const ve of v) {
      if (ve.x >= he.x0 - TOL && ve.x <= he.x1 + TOL && he.y >= ve.y0 - TOL && he.y <= ve.y1 + TOL) {
        points.push({ x: ve.x, y: he.y });
      }
    }
  }
  const hasH = (y: number, x0: number, x1: number): boolean =>
    h.some((e) => Math.abs(e.y - y) <= TOL && e.x0 <= x0 + TOL && e.x1 >= x1 - TOL);
  const hasV = (x: number, y0: number, y1: number): boolean =>
    v.some((e) => Math.abs(e.x - x) <= TOL && e.y0 <= y0 + TOL && e.y1 >= y1 - TOL);

  const cells: Cell[] = [];
  for (const p of points) {
    const right = points.filter((q) => Math.abs(q.y - p.y) <= TOL && q.x > p.x + TOL).sort((a, b) => a.x - b.x);
    const below = points.filter((q) => Math.abs(q.x - p.x) <= TOL && q.y < p.y - TOL).sort((a, b) => b.y - a.y);
    search: for (const b of below) {
      if (!hasV(p.x, b.y, p.y)) continue;
      for (const r of right) {
        if (!hasH(p.y, p.x, r.x)) continue;
        if (hasV(r.x, b.y, p.y) && hasH(b.y, p.x, r.x)) {
          cells.push({ x0: p.x, x1: r.x, y0: b.y, y1: p.y, page, items: [] });
          break search;
        }
      }
    }
    if (cells.length > MAX_CELLS) return [];
  }
  return cells;
}

/** Cells sharing a border belong to the same table; lone boxes aren't tables. */
function groupTables(cells: Cell[]): Table[] {
  const parent = cells.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOL;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      const sideBySide = (near(a.x1, b.x0) || near(b.x1, a.x0)) && a.y0 < b.y1 - TOL && b.y0 < a.y1 - TOL;
      const stacked = (near(a.y0, b.y1) || near(b.y0, a.y1)) && a.x0 < b.x1 - TOL && b.x0 < a.x1 - TOL;
      if (sideBySide || stacked) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Cell[]>();
  cells.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c]));
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({
      cells: g,
      x0: Math.min(...g.map((c) => c.x0)),
      x1: Math.max(...g.map((c) => c.x1)),
      y0: Math.min(...g.map((c) => c.y0)),
      y1: Math.max(...g.map((c) => c.y1)),
    }));
}

/** Midpoint of an item along its own reading direction (works for rotated text). */
function midpoint(item: TextItem): [number, number] {
  const [a, b, , , e, f] = item.transform;
  const len = Math.hypot(a, b) || 1;
  return [e + ((a / len) * item.width) / 2, f + ((b / len) * item.width) / 2];
}

/**
 * The bordered tables on a page, each holding the text items that fall inside
 * its cells. Returns the tables plus the item -> table lookup the caller uses to
 * keep those items out of the running text.
 */
export function findTables(ops: OperatorList, items: TextItem[], page: number): { tables: Table[]; owner: Map<TextItem, Table> } {
  const { h, v } = findEdges(ops);
  const tables = groupTables(findCells(h, v, page));
  const owner = new Map<TextItem, Table>();
  for (const item of items) {
    const [x, y] = midpoint(item);
    for (const t of tables) {
      const cell = t.cells.find((c) => x > c.x0 && x < c.x1 && y > c.y0 && y < c.y1);
      if (cell) {
        cell.items.push(item);
        owner.set(item, t);
        break;
      }
    }
  }
  return { tables: tables.filter((t) => t.cells.some((c) => c.items.some((i) => i.str.trim() !== ""))), owner };
}

// ---------- text lines ----------

interface Line {
  u: [number, number];
  up: number;
  size: number;
  parts: Array<{ item: TextItem; along: number; end: number; size: number }>;
}

/** Where an item sits in its own frame: along its reading direction and along its "up". */
function frame(item: TextItem): { u: [number, number]; along: number; up: number; size: number } {
  const [a, b, c, d, e, f] = item.transform;
  const rl = Math.hypot(a, b) || 1;
  const ul = Math.hypot(c, d) || 1;
  const u: [number, number] = [c / ul, d / ul];
  return { u, along: e * (a / rl) + f * (b / rl), up: e * u[0] + f * u[1], size: ul };
}

function sameLine(line: Line, u: [number, number], up: number, size: number): boolean {
  return (
    Math.abs(line.u[0] - u[0]) < 0.01 &&
    Math.abs(line.u[1] - u[1]) < 0.01 &&
    Math.abs(line.up - up) <= Math.max(size, line.size) * 0.45
  );
}

/** A line's text, with a space wherever items are visibly apart. */
function lineText(line: Line): string {
  let s = "";
  let prevEnd: number | null = null;
  for (const p of line.parts) {
    if (prevEnd !== null && p.along - prevEnd > p.size * 0.25 && !/\s$/.test(s) && !/^\s/.test(p.item.str)) s += " ";
    s += p.item.str;
    prevEnd = p.end;
  }
  return s.replace(/\s+/g, " ").trim();
}

function toLine(item: TextItem): Line {
  const { u, along, up, size } = frame(item);
  return { u, up, size, parts: [{ item, along, end: along + item.width, size }] };
}

function addToLine(line: Line, item: TextItem): void {
  const { along, up, size } = frame(item);
  line.parts.push({ item, along, end: along + item.width, size });
  // A superscript joins the line of the text it sits on, not the other way round.
  if (size > line.size) {
    line.size = size;
    line.up = up;
  }
}

/**
 * Lines of text in content-stream order, as pdf-parse produced them: a new
 * line whenever an item doesn't continue the current one. Stream order is kept
 * (rather than re-sorting by position) because it keeps each text box of a
 * multi-column slide together.
 */
export function streamLines(items: TextItem[]): string[] {
  const lines: string[] = [];
  let current: Line | null = null;
  for (const item of items) {
    const { u, along, up, size } = frame(item);
    const last = current?.parts[current.parts.length - 1];
    if (current && last && sameLine(current, u, up, size) && along >= last.along - size) addToLine(current, item);
    else {
      if (current) lines.push(lineText(current));
      current = toLine(item);
    }
  }
  if (current) lines.push(lineText(current));
  return lines.filter((l) => l !== "");
}

/**
 * A cell's text: its lines ordered by position (top-down in the text's own
 * frame, so a rotated label reads correctly) and re-joined. Line wraps inside a
 * cell are layout, not content, so they become spaces, except a word broken
 * after a hyphen ("up-" / "to-date") and bulleted lines, which stay separate.
 */
function cellText(items: TextItem[]): string {
  const lines: Line[] = [];
  for (const item of items) {
    const { u, up, size } = frame(item);
    const line = lines.find((l) => sameLine(l, u, up, size));
    if (line) addToLine(line, item);
    else lines.push(toLine(item));
  }
  lines.sort((a, b) => b.up - a.up);
  let out = "";
  for (const line of lines) {
    line.parts.sort((a, b) => a.along - b.along);
    const text = lineText(line);
    if (text === "") continue;
    if (out === "") out = text;
    else if (/^[•◦▪▫●○■□➢➤✓\-*–]\s/.test(text)) out += "\n" + text;
    else if (/\w-$/.test(out)) out += text;
    else out += " " + text;
  }
  return out;
}

// ---------- rendering ----------

/** Sorted distinct values, merging any within the snap tolerance. */
function distinct(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length === 0 || v - out[out.length - 1] > TOL) out.push(v);
  }
  return out;
}

/**
 * A table's cells as rows of text. Merged cells keep their text in their
 * top-left position only. Borders that exist in only some rows (Word often
 * draws the header row slightly differently) leave columns that are never
 * filled alongside their neighbour, so those pairs are folded together.
 */
export function tableRows(table: Table): string[][] {
  const xs = distinct(table.cells.flatMap((c) => [c.x0, c.x1]));
  const col = (x: number): number => xs.findIndex((v) => Math.abs(v - x) <= TOL);

  // Rows are keyed by page, then top edge, so a table continued across pages
  // keeps its order.
  const pages = [...new Set(table.cells.map((c) => c.page))].sort((a, b) => a - b);
  const rowKeys: Array<{ page: number; y: number }> = [];
  for (const page of pages) {
    const tops = distinct(table.cells.filter((c) => c.page === page).map((c) => c.y1)).reverse();
    for (const y of tops) rowKeys.push({ page, y });
  }
  const row = (c: Cell): number => rowKeys.findIndex((k) => k.page === c.page && Math.abs(k.y - c.y1) <= TOL);

  const rows = rowKeys.map(() => Array<string>(Math.max(xs.length - 1, 1)).fill(""));
  for (const c of table.cells) {
    const r = row(c);
    const k = col(c.x0);
    // Two cells can snap to the same slot (a double border leaves a sliver
    // cell); combine rather than overwrite, so no text is ever dropped.
    if (r >= 0 && k >= 0 && k < rows[r].length) rows[r][k] = [rows[r][k], cellText(c.items)].filter(Boolean).join(" ");
  }

  for (let k = 0; k < rows[0].length - 1; ) {
    if (rows.every((r) => r[k] === "" || r[k + 1] === "")) {
      for (const r of rows) {
        r[k] = r[k] || r[k + 1];
        r.splice(k + 1, 1);
      }
    } else k += 1;
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/**
 * Whether `next` (the first table on a page) carries on `prev` (the last table
 * on the page before): same outer edges and the same column borders. Word
 * tables that run over a page break come out as one table per page otherwise,
 * and every page after the first would lose its header row.
 */
export function continues(prev: Table, next: Table): boolean {
  if (Math.abs(prev.x0 - next.x0) > TOL || Math.abs(prev.x1 - next.x1) > TOL) return false;
  const prevXs = distinct(prev.cells.flatMap((c) => [c.x0, c.x1]));
  const nextXs = distinct(next.cells.flatMap((c) => [c.x0, c.x1]));
  return nextXs.every((x) => prevXs.some((p) => Math.abs(p - x) <= TOL));
}
