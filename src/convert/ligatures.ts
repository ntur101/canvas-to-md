/**
 * Repair of words broken by typographic ligatures in PDF text.
 *
 * The motivating case: ENGGEN 403's handouts are Word documents exported with
 * "Acrobat PDFMaker for Word". Its Calibri font map (the PDF's ToUnicode CMap)
 * maps the "ti", "tti" and "ft" ligature glyphs to U+FFFD and maps the "tt"
 * ligature to a single "t". Every extractor reads the same map, so the text
 * comes out as "sec�on", "a�er" and "writen" whichever library is
 * used. The damage is in the PDF itself; this puts the letters back.
 *
 * Two passes, both dictionary-backed and ranked by word frequency so the
 * common word wins (e.g. "formatting" over the rare variant "formating"):
 *   1. U+FFFD inside a word: try each ligature in its place and keep the most
 *      common real word. U+FFFD is a certain signal that a ligature was there,
 *      so any listed word may win, and a dropped "tt" elsewhere in the same
 *      word is also tried ("aten�on" -> "attention").
 *   2. A dropped "tt" leaves no marker at all, so it's only attempted in text
 *      that already shows the U+FFFD damage, only for words absent from the
 *      dictionary, and only when doubling a "t" gives a common word
 *      ("writen" -> "written", "atempt" -> "attempt").
 * Anything it can't place confidently (proper nouns like "Microso�",
 * emoji) is left exactly as extracted, still marked, rather than guessed.
 */

import { createRequire } from "node:module";

const LIGATURES = ["ti", "tti", "ft", "tt", "fi", "fl", "ff", "ffi", "ffl", "tf", "th"];
const REPLACEMENT = "�";
/** Frequency tiers from wordlist-english: 10 = most common ... 70 = rare. */
const TIERS = [10, 20, 35, 40, 50, 55, 60, 70];
/** Up to this tier counts as a common word, for the unmarked "tt" pass. */
const COMMON_TIER = 60;
/** Words with more broken slots than this are left alone (combinations explode). */
const MAX_SLOTS = 3;

let tiers: Map<string, number> | null = null;

/** word -> lowest frequency tier across US/British/Australian spellings. Loaded on first use. */
function tierMap(): Map<string, number> {
  if (tiers) return tiers;
  const lists = createRequire(import.meta.url)("wordlist-english") as Record<string, string[]>;
  tiers = new Map();
  for (const variant of ["", "american/", "british/", "australian/"]) {
    for (const t of TIERS) {
      for (const w of lists[`english/${variant}${t}`] ?? []) {
        const prev = tiers.get(w);
        if (prev === undefined || t < prev) tiers.set(w, t);
      }
    }
  }
  return tiers;
}

function tierOf(word: string): number {
  const map = tierMap();
  const lower = word.toLowerCase();
  return map.get(lower) ?? (lower.endsWith("s") ? map.get(lower.slice(0, -1)) : undefined) ?? Infinity;
}

/** The most common candidate that passes `ok`, or null. */
function mostCommon(candidates: string[], ok: (w: string) => boolean): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (ok(c) && (best === null || tierOf(c) < tierOf(best))) best = c;
  }
  return best;
}

/** Every way of inserting one extra "t" after an existing "t". */
function withDoubledT(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "t") out.push(word.slice(0, i) + "t" + word.slice(i));
  }
  return out;
}

function repairMarked(word: string): string {
  const slots = word.split(REPLACEMENT);
  const gaps = slots.length - 1;
  if (gaps > MAX_SLOTS) return word;

  let combos: string[][] = [[]];
  for (let i = 0; i < gaps; i++) combos = combos.flatMap((c) => LIGATURES.map((l) => [...c, l]));
  const candidates = combos.map((c) => slots.reduce((acc, s, i) => acc + (i > 0 ? c[i - 1] : "") + s, ""));

  const listed = (w: string): boolean => tierOf(w) !== Infinity;
  return (
    mostCommon(candidates, listed) ??
    mostCommon(candidates.flatMap((c) => [c, ...withDoubledT(c)]), listed) ??
    candidates.find(isCompound) ??
    word
  );
}

/**
 * Two common words run together ("timeframes", "Microsoft"), or a common word
 * plus a suffix ("impactful", "narratively"), which the word list lacks.
 */
function isCompound(word: string): boolean {
  const derived = word.match(/^(.{4,}?)(ly|ful|ness|less)$/i);
  if (derived && tierOf(derived[1]) <= COMMON_TIER) return true;
  for (let i = 3; i <= word.length - 3; i++) {
    if (tierOf(word.slice(0, i)) <= COMMON_TIER && tierOf(word.slice(i)) <= COMMON_TIER) return true;
  }
  return false;
}

function repairDroppedTT(word: string): string {
  if (word.length <= 4 || !word.includes("t") || tierOf(word) !== Infinity) return word;
  return mostCommon(withDoubledT(word), (w) => tierOf(w) <= COMMON_TIER) ?? word;
}

export interface LigatureRepair {
  text: string;
  /** Words repaired from a U+FFFD marker. */
  marked: number;
  /** Words repaired from a silently dropped "tt". */
  doubled: number;
}

/** Repair ligature damage in extracted PDF text. A no-op for text without U+FFFD. */
export function repairLigatures(text: string): LigatureRepair {
  if (!text.includes(REPLACEMENT)) return { text, marked: 0, doubled: 0 };
  let marked = 0;
  let doubled = 0;
  const out = text.replace(/[\p{L}�]+/gu, (word) => {
    let fixed = word;
    if (word.includes(REPLACEMENT) && /\p{L}/u.test(word)) {
      fixed = repairMarked(word);
      if (fixed !== word) marked += 1;
    } else if (/^[a-z]+$/i.test(word)) {
      fixed = repairDroppedTT(word);
      if (fixed !== word) doubled += 1;
    }
    return fixed;
  });
  return { text: out, marked, doubled };
}
