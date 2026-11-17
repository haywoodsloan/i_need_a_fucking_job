/** Reading the dates on a resume. The text stays as written. This is only the structured reading kept beside it. */
import { describe, expect, it } from 'vitest';
import { findDate, parsePartialDate } from './dates';

describe('one date as written on a resume', () => {
  it.each([
    ['Jan 2020', { year: 2020, month: 1 }],
    ['January 2020', { year: 2020, month: 1 }],
    ['Sept. 2019', { year: 2019, month: 9 }],
    ['June, 2021', { year: 2021, month: 6 }],
    ["May '19", { year: 2019, month: 5 }],
    ["Dec '98", { year: 1998, month: 12 }],
    ['Summer 2022', { year: 2022, month: 6 }],
    ['Fall 2020', { year: 2020, month: 9 }],
    ['Winter 2021', { year: 2021, month: 1 }],
    ['05/2019', { year: 2019, month: 5 }],
    ['5/19', { year: 2019, month: 5 }],
    ['2018-06', { year: 2018, month: 6 }],
    ['2018.6', { year: 2018, month: 6 }],
    ['2018', { year: 2018 }],
    ['  2018  ', { year: 2018 }],
  ])('%j is read as %j', (text, expected) => {
    expect(parsePartialDate(text)).toEqual(expected);
  });

  it('keeps the year and drops a month that cannot be one', () => {
    expect(parsePartialDate('13/2019')).toEqual({ year: 2019, month: undefined });
    expect(parsePartialDate('2019-00')).toEqual({ year: 2019, month: undefined });
  });

  it.each(['', 'Present', 'Python 3', '1850', '20201', 'Q3'])('%j is not a date', (text) => {
    expect(parsePartialDate(text)).toBeUndefined();
  });
});

describe('the date in a line of a resume', () => {
  const found = (line: string) => {
    const d = findDate(line);
    return d && { text: line.slice(d.start, d.end), from: d.from, to: d.to, current: d.current, isRange: d.isRange };
  };

  it.each([
    ['Senior Software Engineer | Jan 2021 – Present', { text: 'Jan 2021 – Present', from: { year: 2021, month: 1 }, to: undefined, current: true, isRange: true }],
    ['Software Developer Intern  May 2017 - Aug 2017', { text: 'May 2017 - Aug 2017', from: { year: 2017, month: 5 }, to: { year: 2017, month: 8 }, current: false, isRange: true }],
    ['2018-2020', { text: '2018-2020', from: { year: 2018 }, to: { year: 2020 }, current: false, isRange: true }],
    ['05/2019 to 06/2021', { text: '05/2019 to 06/2021', from: { year: 2019, month: 5 }, to: { year: 2021, month: 6 }, current: false, isRange: true }],
    ['Acme Corp (2016 through 2019)', { text: '2016 through 2019', from: { year: 2016 }, to: { year: 2019 }, current: false, isRange: true }],
    ['Mar 2020 — current', { text: 'Mar 2020 — current', from: { year: 2020, month: 3 }, to: undefined, current: true, isRange: true }],
    ['Research Assistant, Summer 2022', { text: 'Summer 2022', from: { year: 2022, month: 6 }, to: undefined, current: false, isRange: false }],
    ['B.S. in Computer Science, May 2018', { text: 'May 2018', from: { year: 2018, month: 5 }, to: undefined, current: false, isRange: false }],
    ['Expected May 2027', { text: 'Expected May 2027', from: { year: 2027, month: 5 }, to: undefined, current: false, isRange: false }],
  ])('in %j', (line, expected) => {
    expect(found(line)).toEqual(expected);
  });

  it('prefers a range to a single date on the same line', () => {
    expect(found('Class of 2015, then Analyst 2016 – 2018')).toMatchObject({ text: '2016 – 2018', isRange: true });
    // With no range, the first date on the line is the one.
    expect(found('Graduated 2015, promoted 2018')).toMatchObject({ from: { year: 2015 }, isRange: false });
  });

  it.each(['Python 3', 'Led a team of 12 engineers', 'Model X2020', 'Order 20201 shipped', 'ISO27001 audit', ''])('finds no date in %j', (line) => {
    expect(findDate(line)).toBeUndefined();
  });
});
