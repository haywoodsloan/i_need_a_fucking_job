// @vitest-environment jsdom
/**
 * Property tests for the sanitizer: instead of a list of known attacks (sanitize.test.ts), these make up thousands
 * of pieces of broken and hostile HTML and hold every one of them to the same rules. When one fails, fast-check
 * prints the smallest input that still fails, and the seed to run it again.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unsafeParts } from '../testing/html';
import { sanitizeHtml, termsRegex, textToHtml } from './sanitize';

const TAGS = [
  // kept
  'p', 'b', 'i', 'a', 'ul', 'li', 'div', 'span', 'table', 'tr', 'td', 'h2', 'blockquote', 'br',
  // dropped with what is inside them
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'noscript', 'template', 'svg', 'math',
  // unwrapped, or with parsing rules of their own
  'img', 'video', 'audio', 'link', 'meta', 'base', 'body', 'html', 'head', 'title', 'plaintext', 'xmp', 'listing', 'noembed', 'noframes', 'frameset', 'marquee', 'details', 'foreignObject', 'desc', 'mi', 'mtext', 'annotation-xml', 'x-custom', 'ScRiPt', 'A', 'SVG',
];
const ATTRIBUTE_NAMES = ['href', 'HREF', 'src', 'srcdoc', 'style', 'class', 'id', 'onclick', 'onerror', 'onload', 'ONMOUSEOVER', 'formaction', 'xlink:href', 'target', 'rel', 'action', 'data-x', 'is', 'slot', 'name', 'encoding'];
const SCHEMES = ['https://', 'http://', 'HTTPS://', 'javascript:', 'JaVaScRiPt:', 'java\tscript:', ' javascript:', 'data:text/html,', 'vbscript:', '//', '/', '#', 'mailto:', 'blob:', ''];

const text = fc.oneof(fc.string(), fc.string({ unit: 'grapheme' }), fc.constantFrom('<', '>', '&', '"', "'", '&lt;', '&amp;lt;', '&#60;', '&#x3c;script&#x3e;', '<!--', '-->', ']]>', '<![CDATA[', '\u0000', '\r\n', '`', '=', '/'));
const attributeValue = fc.oneof(text, fc.tuple(fc.constantFrom(...SCHEMES), text).map(([scheme, rest]) => scheme + rest));
const attribute = fc.tuple(fc.constantFrom(...ATTRIBUTE_NAMES), attributeValue, fc.constantFrom('"', "'", '')).map(([name, value, quote]) => ` ${name}=${quote}${value}${quote}`);

/** Markup the way the web really has it: nested, cut short, closed twice, with comments and stray brackets. */
const { markup } = fc.letrec<{ markup: string; node: string }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    text,
    fc.tuple(fc.constantFrom(...TAGS), fc.array(attribute, { maxLength: 3 }), tie('markup'), fc.constantFrom('closed', 'open', 'self', 'twice')).map(([tag, attributes, inside, how]) => {
      const open = `<${tag}${attributes.join('')}`;
      if (how === 'self') return `${open}/>${inside}`;
      if (how === 'open') return `${open}>${inside}`;
      return `${open}>${inside}</${tag}>${how === 'twice' ? `</${tag}>` : ''}`;
    }),
    tie('markup').map((inside) => `<!--${inside}-->`),
  ),
  markup: fc.array(tie('node'), { maxLength: 4 }).map((nodes) => nodes.join('')),
}));

const terms = fc.array(fc.oneof(fc.constantFrom('script', 'onerror', 'javascript', 'C++', 'C#', '.NET', '<b>', 'a', 'href'), fc.string({ minLength: 2, maxLength: 12 })), { minLength: 1, maxLength: 6 });

describe('whatever HTML a job site sends', () => {
  it('comes out with only the allowed tags and no attribute but the address of a web link', () => {
    fc.assert(
      fc.property(markup, (html) => {
        expect(unsafeParts(sanitizeHtml(html))).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });

  // Not held: that sanitizing the output again gives the same text of HTML back. Taking a tag away can leave a
  // paragraph inside a paragraph, which HTML cannot write down, so the browser reads it back as two. The rule above
  // is checked on what the browser reads back, which is what counts.
  it('is still clean when what came out is put through again', () => {
    fc.assert(
      fc.property(markup, (html) => {
        expect(unsafeParts(sanitizeHtml(sanitizeHtml(html)))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('stays clean when skills are highlighted in it, and a highlight holds text only', () => {
    fc.assert(
      fc.property(markup, terms, (html, skills) => {
        const out = sanitizeHtml(html, termsRegex(skills));
        expect(unsafeParts(out)).toEqual([]);
        const host = document.createElement('div');
        host.innerHTML = out;
        for (const mark of host.querySelectorAll('mark')) expect(mark.children).toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });

  it('is clean for text that is not HTML at all', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (anything) => {
        expect(unsafeParts(sanitizeHtml(anything))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('a description that came as plain text', () => {
  /** What the page shows, without the line ends, which become paragraphs and line breaks. */
  const shown = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.textContent!.replace(/[\r\n\0]/g, '');
  };

  it('is shown with every character it had, none of them read as markup', () => {
    fc.assert(
      fc.property(text.chain((first) => fc.array(text, { maxLength: 6 }).map((rest) => [first, ...rest].join('\n'))), (plain) => {
        const out = textToHtml(plain);
        expect(unsafeParts(out)).toEqual([]);
        expect(shown(out)).toBe(plain.replace(/[\r\n\0]/g, ''));
        const host = document.createElement('div');
        host.innerHTML = out;
        expect([...host.querySelectorAll('*')].every((el) => el.tagName === 'P' || el.tagName === 'BR')).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('keeps every character when skills are highlighted, and adds nothing but the highlights', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), terms, (plain, skills) => {
        const out = textToHtml(plain, termsRegex(skills));
        expect(unsafeParts(out)).toEqual([]);
        expect(shown(out)).toBe(plain.replace(/[\r\n\0]/g, ''));
      }),
      { numRuns: 300 },
    );
  });
});
