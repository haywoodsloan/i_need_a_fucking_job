import type { PartialDate } from './model';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const SEASONS: Record<string, number> = { winter: 1, spring: 3, summer: 6, fall: 9, autumn: 9 };

const MONTH_RE =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const SEASON_RE = '(?:Spring|Summer|Fall|Autumn|Winter)';
const YEAR_RE = "(?:19|20)\\d{2}|'\\d{2}";
export const DATE_RE_SRC =
  `(?:${MONTH_RE},?\\s+(?:${YEAR_RE})|${SEASON_RE}\\s+(?:${YEAR_RE})|\\d{1,2}\\/(?:19|20)\\d{2}|(?:19|20)\\d{2}[-/.]\\d{1,2}(?!\\d)|\\d{1,2}\\/\\d{2}(?!\\d)|(?:19|20)\\d{2})`;
const PRESENT_RE_SRC = '(?:Present|Current(?:ly)?|Now|Today|Ongoing|Date)';
const SEP_RE_SRC = '\\s*(?:-|–|—|−|~|to|until|through|thru)\\s*';

/** "Jan 2020 – Present", "2018-2020", "05/2019 to 06/2021", "Summer 2022". */
export const DATE_RANGE_RE = new RegExp(
  `(?:(?:Expected|Anticipated|Graduated|Graduation|Grad\\.?)[:\\s]+)?(${DATE_RE_SRC})(?:${SEP_RE_SRC}(${DATE_RE_SRC}|${PRESENT_RE_SRC}))?`,
  'i',
);

export function parsePartialDate(s: string): PartialDate | undefined {
  const t = s.trim().replace(/\.$/, '');
  let m = t.match(/^([A-Za-z]+)\.?,?\s+((?:19|20)\d{2}|'\d{2})$/);
  if (m) {
    const year = toYear(m[2]);
    const key = m[1].toLowerCase();
    const month = MONTHS[key.slice(0, 3)] ?? SEASONS[key];
    return { year, month };
  }
  m = t.match(/^(\d{1,2})\/((?:19|20)\d{2}|\d{2})$/);
  if (m) return { year: toYear(m[2]), month: clampMonth(+m[1]) };
  m = t.match(/^((?:19|20)\d{2})[-/.](\d{1,2})$/);
  if (m) return { year: +m[1], month: clampMonth(+m[2]) };
  m = t.match(/^((?:19|20)\d{2})$/);
  if (m) return { year: +m[1] };
  return undefined;
}

function toYear(y: string): number {
  if (y.startsWith("'")) y = y.slice(1);
  if (y.length === 2) {
    const n = +y;
    return n > 50 ? 1900 + n : 2000 + n;
  }
  return +y;
}

function clampMonth(m: number): number | undefined {
  return m >= 1 && m <= 12 ? m : undefined;
}

export interface DateMatch {
  /** Offsets relative to the searched string. */
  start: number;
  end: number;
  from?: PartialDate;
  to?: PartialDate;
  current: boolean;
  isRange: boolean;
}

/**
 * Finds the most date-like substring in a line. A range beats a single date;
 * a bare 4-digit year only counts when it sits alone or at a token edge, so
 * "Python 3" or "Route 2020 project" style noise is less likely.
 */
export function findDate(line: string): DateMatch | undefined {
  const re = new RegExp(DATE_RANGE_RE.source, 'gi');
  let best: DateMatch | undefined;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const before = line[m.index - 1];
    const after = line[m.index + m[0].length];
    if ((before && /[A-Za-z0-9]/.test(before)) || (after && /[A-Za-z0-9]/.test(after))) continue;
    const isRange = !!m[2];
    const toTxt = m[2];
    const current = !!toTxt && new RegExp(`^${PRESENT_RE_SRC}$`, 'i').test(toTxt.trim());
    const cand: DateMatch = {
      start: m.index,
      end: m.index + m[0].length,
      from: parsePartialDate(m[1]),
      to: toTxt && !current ? parsePartialDate(toTxt) : undefined,
      current,
      isRange,
    };
    if (!best || (cand.isRange && !best.isRange)) best = cand;
  }
  return best;
}
