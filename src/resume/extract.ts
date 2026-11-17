/**
 * Turns an uploaded file into a SourceDocument: plain text with line and
 * (for PDFs) position data. Everything runs in the browser; the resume never
 * leaves the user's machine.
 *
 * The builders here are pure so they can be tested in Node. The loaders that
 * need pdf.js / mammoth are in `load.ts`.
 */
import type { SourceDocument, SourceItem, SourceLine } from './model';

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lines of plain text → SourceDocument (no positions). */
export function buildTextSource(
  rawText: string,
  meta: { fileName: string; mimeType: string; kind: 'text' | 'docx'; sha256: string },
): SourceDocument {
  const text = rawText.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[ \t]+$/gm, '');
  const lines: SourceLine[] = [];
  let pos = 0;
  for (const l of text.split('\n')) {
    lines.push({ start: pos, end: pos + l.length });
    pos += l.length + 1;
  }
  return { ...meta, text, lines, importedAt: new Date().toISOString() };
}

/**
 * mammoth's HTML → text lines. List items get a "• " marker so the parser
 * can tell bullets from headers (the marker itself is never part of a field).
 * Table cells are separated by a wide gap, which the parser treats as a
 * column separator.
 */
export function docxHtmlToText(html: string): string {
  return decodeEntities(
    rowsToLines(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(td|th)>/gi, '   ')
      .replace(/<\/?(p|h[1-6]|ul|ol|li|tr|table|div)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A table row whose cells hold one line each ("Data Analyst | Mar 2020 – Present") becomes that one line. mammoth
 * wraps the text of every cell in a paragraph, which would otherwise put each cell on a line of its own.
 *
 * A row with more in a cell (a list, several paragraphs, another table) is a page layout and not a line of text.
 * It is left alone: each of its paragraphs stays a line, cell after cell.
 */
function rowsToLines(html: string): string {
  // Only rows with no row inside them, so the rows of a table within a table are read too.
  return html.replace(/<tr[^>]*>((?:(?!<tr\b).)*?)<\/tr>/gis, (row: string, inside: string) => {
    if (/<(table|li|br)\b/i.test(inside)) return row;
    const cells = [...inside.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)].map((m) => m[1]);
    if (!cells.length || cells.some((cell) => (cell.match(/<(p|h[1-6]|div)\b/gi) ?? []).length > 1)) return row;
    const texts = cells.map((cell) => cell.replace(/<\/?(p|h[1-6]|div)[^>]*>/gi, '')).filter((cell) => cell.replace(/<[^>]+>/g, '').trim());
    return `<p>${texts.join('   ')}</p>`;
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** A text run as pdf.js reports it (getTextContent().items). */
export interface RawPdfItem {
  str: string;
  /** [a, b, c, d, e, f] — e,f is the baseline origin in PDF space (y up). */
  transform: number[];
  width: number;
  height: number;
}

export interface RawPdfPage {
  width: number;
  height: number;
  items: RawPdfItem[];
}

/**
 * Rebuilds reading-order lines from positioned PDF text runs.
 *
 * Runs on the same baseline become one line; a wide horizontal gap inside a
 * line becomes a 3-space separator so "Name        email" style headers split
 * into tokens. Each run keeps its box so the review screen can highlight the
 * exact place on the rendered page.
 */
export function buildPdfSource(
  pages: RawPdfPage[],
  meta: { fileName: string; mimeType: string; sha256: string },
): SourceDocument {
  let text = '';
  const lines: SourceLine[] = [];
  const items: SourceItem[] = [];

  pages.forEach((page, pageIndex) => {
    const runs = page.items
      .filter((it) => it.str.length > 0)
      .map((it) => {
        const fontH = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        const x = it.transform[4];
        const baseline = page.height - it.transform[5];
        return { str: it.str, x, y: baseline - fontH * 0.8, w: it.width, h: fontH, baseline };
      })
      .sort((a, b) => a.baseline - b.baseline || a.x - b.x);

    // Group into visual lines by baseline proximity.
    const rows: (typeof runs)[] = [];
    for (const r of runs) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].baseline - r.baseline) < Math.max(2, r.h * 0.35)) row.push(r);
      else rows.push([r]);
    }

    if (pageIndex > 0 && lines.length) {
      // Blank line between pages.
      text += '\n';
      lines.push({ start: text.length, end: text.length, page: pageIndex });
    }

    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      if (row.every((r) => !r.str.trim())) continue;
      if (lines.length) text += '\n';
      const lineStart = text.length;
      let prevEnd: number | undefined;
      let avgChar = 0;
      for (const r of row) {
        const charW = r.str.length ? r.w / r.str.length : r.h * 0.5;
        avgChar = avgChar ? (avgChar + charW) / 2 : charW;
        if (prevEnd !== undefined) {
          const gap = r.x - prevEnd;
          const endsSpace = /\s$/.test(text);
          const startsSpace = /^\s/.test(r.str);
          // A column break only means something after visible text. Before any, there is nothing on this line to
          // trim back to, and trimming would run on into the line above and join the two.
          const hasText = text.slice(lineStart).trim().length > 0;
          if (gap > avgChar * 3 && hasText) text = text.replace(/\s+$/, '') + '   ';
          else if (gap > avgChar * 0.25 && !endsSpace && !startsSpace) text += ' ';
        }
        const s = text.length;
        text += r.str;
        if (r.str.trim()) {
          const lead = r.str.length - r.str.trimStart().length;
          items.push({
            start: s + lead,
            end: s + r.str.trimEnd().length,
            page: pageIndex,
            box: { x: r.x, y: r.y, w: r.w, h: r.h },
          });
        }
        prevEnd = r.x + r.w;
      }
      // Trim trailing spaces from the line.
      const trimmed = text.replace(/[ \t]+$/, '');
      text = trimmed;
      const xs = row.map((r) => r.x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...row.map((r) => r.x + r.w));
      const top = Math.min(...row.map((r) => r.y));
      const bottom = Math.max(...row.map((r) => r.y + r.h));
      lines.push({ start: lineStart, end: text.length, page: pageIndex, box: { x: minX, y: top, w: maxX - minX, h: bottom - top } });
    }
  });

  return {
    ...meta,
    kind: 'pdf',
    text,
    lines,
    pages: pages.map((p) => ({ width: p.width, height: p.height })),
    items,
    importedAt: new Date().toISOString(),
  };
}
