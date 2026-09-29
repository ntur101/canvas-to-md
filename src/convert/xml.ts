/**
 * Small XML helpers shared by the Office converters (docx, pptx). Office XML is
 * regular enough to walk with regexes, as long as nesting is respected: a table
 * can sit inside a table cell, and a lazy `<x>...</x>` match would stop at the
 * inner closing tag and cut the outer element short.
 */

/** Decode the handful of XML entities that appear in Office text runs. */
export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface Element {
  tag: string;
  xml: string;
  /** Offset of the element's opening tag in the string it was found in. */
  start: number;
}

/**
 * The outermost elements named in `tags` within `xml`, in document order. Each
 * is matched to its own closing tag by depth, so anything nested inside it
 * (including another element with the same name) stays inside it. Elements of
 * other names are looked through, not skipped.
 */
export function children(xml: string, tags: string[]): Element[] {
  const open = new RegExp(`<(${tags.join("|")})(?=[\\s>/])[^>]*?(/?)>`, "g");
  const out: Element[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const tag = m[1];
    const start = m.index;
    if (m[2] === "/") {
      out.push({ tag, xml: m[0], start });
      continue;
    }
    const any = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*?(/?)>`, "g");
    any.lastIndex = open.lastIndex;
    let depth = 1;
    let end = xml.length;
    let t: RegExpExecArray | null;
    while ((t = any.exec(xml))) {
      if (t[2] === "/") continue; // self-closing: no effect on depth
      depth += t[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = any.lastIndex;
        break;
      }
    }
    out.push({ tag, xml: xml.slice(start, end), start });
    open.lastIndex = end;
  }
  return out;
}

/** The part of an element between its own opening and closing tags. */
export function inner(xml: string): string {
  const openEnd = xml.indexOf(">") + 1;
  const closeStart = xml.lastIndexOf("</");
  return closeStart > openEnd ? xml.slice(openEnd, closeStart) : "";
}
