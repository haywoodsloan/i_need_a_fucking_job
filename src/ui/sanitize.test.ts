// @vitest-environment jsdom
/**
 * Attack tests for the job description sanitizer. Descriptions are third-party HTML, and the page shows the
 * sanitizer's output as HTML, so each payload is checked the way the page would treat it: sanitized, then parsed
 * again by the browser.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeHtml, termsRegex, textToHtml } from './sanitize';
import { XSS_PAYLOADS } from './sanitize.test-payloads';

const KEPT = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'div', 'span', 'table', 'tbody', 'tr', 'td', 'th', 'blockquote', 'mark']);

/** Everything in a piece of HTML that the sanitizer should never let through. Empty means clean. */
export function unsafeParts(html: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  const found: string[] = [];
  for (const el of host.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !KEPT.has(tag)) found.push(`<${tag}>`);
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name) ?? '';
      const fine =
        tag === 'a' && ((name === 'href' && /^https?:\/\//i.test(value)) || (name === 'target' && value === '_blank') || (name === 'rel' && value === 'noopener noreferrer nofollow'));
      if (!fine) found.push(`<${tag} ${name}="${value}">`);
    }
    // A link that goes somewhere always opens in a new tab and tells the other site nothing about this one.
    if (tag === 'a' && el.hasAttribute('href') && !(el.hasAttribute('target') && el.hasAttribute('rel'))) found.push('<a href> without target and rel');
  }
  return found;
}

describe('the job description sanitizer', () => {
  it.each(XSS_PAYLOADS)('leaves nothing dangerous in %j', (payload) => {
    const out = sanitizeHtml(payload);
    expect(unsafeParts(out)).toEqual([]);
    // Sanitizing its own output changes nothing: the output means the same thing when it is parsed again.
    expect(sanitizeHtml(out)).toBe(out);
  });

  it.each(XSS_PAYLOADS)('stays clean when skills are highlighted in %j', (payload) => {
    const highlight = termsRegex(['script', 'img', 'onerror', 'window', 'click', 'javascript', 'style', 'C++', '<b>']);
    const out = sanitizeHtml(payload, highlight);
    expect(unsafeParts(out)).toEqual([]);
    const host = document.createElement('div');
    host.innerHTML = out;
    // A highlight wraps text and nothing else.
    for (const mark of host.querySelectorAll('mark')) expect(mark.children).toHaveLength(0);
  });

  it('drops scripts, styles and embedded things together with what is inside them', () => {
    expect(sanitizeHtml('<p>before<script>window.__xss=1</script>after</p>')).toBe('<p>beforeafter</p>');
    expect(sanitizeHtml('<style>*{background:url("https://evil.example/track")}</style><p>text</p>')).toBe('<p>text</p>');
    expect(sanitizeHtml('<iframe src="https://evil.example/">fallback</iframe>')).toBe('');
    expect(sanitizeHtml('<form action="https://evil.example/steal"><input name="password"><p>inside a form</p></form>')).toBe('');
    expect(sanitizeHtml('<svg><script>window.__xss=1</script><text>drawn</text></svg>')).toBe('');
    expect(sanitizeHtml('<svg><foreignObject><p>inside</p></foreignObject></svg><p>outside</p>')).toBe('<p>outside</p>');
    expect(sanitizeHtml('<math><mi>x</mi><annotation-xml encoding="text/html"><img src=x onerror=window.__xss=1></annotation-xml></math>')).toBe('');
    expect(sanitizeHtml('<div><template><p>held back</p></template>shown</div>')).toBe('<div>shown</div>');
  });

  it('keeps the text of tags it does not know, without the tags', () => {
    expect(sanitizeHtml('<p>Uses C++, C# and <unknown-tag>F#</unknown-tag></p>')).toBe('<p>Uses C++, C# and F#</p>');
    expect(sanitizeHtml('<b><marquee onstart=window.__xss=1>hi</marquee></b>')).toBe('<b>hi</b>');
    expect(sanitizeHtml('<img src="https://evil.example/track.gif" alt="logo">after')).toBe('after');
    expect(sanitizeHtml('<details open ontoggle=window.__xss=1><summary>More</summary> detail</details>')).toBe('More detail');
  });

  it('copies no attribute except the address of a web link', () => {
    expect(sanitizeHtml('<p class="a" id="b" style="color:red" onclick="window.__xss=1" data-x="1" title="t" dir="rtl" hidden>text</p>')).toBe('<p>text</p>');
    expect(sanitizeHtml('<a href="https://ok.example/" onclick="window.__xss=1" style="color:red" target="_top" rel="opener" id="location" download>link</a>')).toBe(
      '<a href="https://ok.example/" target="_blank" rel="noopener noreferrer nofollow">link</a>',
    );
    expect(sanitizeHtml('<td colspan="2" background="https://evil.example/t.gif">cell</td>')).toBe('cell');
    expect(sanitizeHtml('<table><tr><td colspan="2" background="https://evil.example/t.gif">cell</td></tr></table>')).toBe('<table><tbody><tr><td>cell</td></tr></tbody></table>');
  });

  it('keeps only links that start with http:// or https://', () => {
    const noLink = '<a>x</a>';
    for (const href of [
      'javascript:window.__xss=1',
      'JaVaScRiPt:window.__xss=1',
      ' javascript:window.__xss=1',
      'java\tscript:window.__xss=1',
      '&#106;avascript:window.__xss=1',
      'data:text/html,<script>window.__xss=1</script>',
      'vbscript:msgbox(1)',
      '//evil.example/',
      '/relative',
      'mailto:a@example.com',
      'file:///etc/passwd',
      ' https://ok.example/',
    ]) {
      expect(sanitizeHtml(`<a href="${href}">x</a>`), href).toBe(noLink);
    }
    expect(sanitizeHtml('<a href="HTTPS://OK.example/Path?a=1&amp;b=2#frag">x</a>')).toBe('<a href="HTTPS://OK.example/Path?a=1&amp;b=2#frag" target="_blank" rel="noopener noreferrer nofollow">x</a>');
    expect(sanitizeHtml('<a href="http://ok.example/">x</a>')).toContain('href="http://ok.example/"');
  });

  it('cannot be talked out of an attribute by quotes or brackets in an address', () => {
    const out = sanitizeHtml('<a href=\'https://ok.example/"><img src=x onerror=window.__xss=1>\'>x</a>');
    expect(unsafeParts(out)).toEqual([]);
    const host = document.createElement('div');
    host.innerHTML = out;
    expect(host.querySelectorAll('*')).toHaveLength(1);
    expect(host.querySelector('a')!.getAttribute('href')).toBe('https://ok.example/"><img src=x onerror=window.__xss=1>');
  });

  it('keeps text that only looks like markup as text', () => {
    expect(sanitizeHtml('&lt;script&gt;window.__xss=1&lt;/script&gt;')).toBe('&lt;script&gt;window.__xss=1&lt;/script&gt;');
    expect(sanitizeHtml('Salary &lt; $90k &amp; equity <b>bold</b> a < b > c')).toBe('Salary &lt; $90k &amp; equity <b>bold</b> a &lt; b &gt; c');
    expect(sanitizeHtml('<xmp><img src=x onerror=window.__xss=1></xmp>')).toBe('&lt;img src=x onerror=window.__xss=1&gt;');
    expect(sanitizeHtml('<!-- <img src=x onerror=window.__xss=1> --><p>after a comment</p>')).toBe('<p>after a comment</p>');
  });

  it('highlights skills as text, even when a skill looks like markup', () => {
    const highlight = termsRegex(['<img src=x onerror=window.__xss=1>', 'Go', 'C++']);
    expect(sanitizeHtml('<p>We use Go and C++ here</p>', highlight)).toBe('<p>We use <mark>Go</mark> and <mark>C++</mark> here</p>');
    const out = sanitizeHtml('<p>&lt;img src=x onerror=window.__xss=1&gt; and Go</p>', highlight);
    expect(unsafeParts(out)).toEqual([]);
    expect(out).toBe('<p><mark>&lt;img src=x onerror=window.__xss=1&gt;</mark> and <mark>Go</mark></p>');
  });

  it('turns plain text into paragraphs without reading any of it as markup', () => {
    expect(textToHtml('<img src=x onerror=window.__xss=1>\nsecond line\n\n<script>window.__xss=1</script>')).toBe(
      '<p>&lt;img src=x onerror=window.__xss=1&gt;<br>second line</p><p>&lt;script&gt;window.__xss=1&lt;/script&gt;</p>',
    );
    expect(unsafeParts(textToHtml('<a href="javascript:window.__xss=1">x</a> & "quotes"', termsRegex(['href', 'quotes'])))).toEqual([]);
  });

  it('copes with very deep and very long descriptions', () => {
    const deep = `${'<div>'.repeat(2000)}deep${'</div>'.repeat(2000)}`;
    expect(unsafeParts(sanitizeHtml(deep))).toEqual([]);
    expect(sanitizeHtml(deep)).toContain('deep');
    const long = '<p onclick="window.__xss=1">row</p>'.repeat(5000);
    expect(sanitizeHtml(long)).toBe('<p>row</p>'.repeat(5000));
  });
});
