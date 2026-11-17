/** What the tests of the sanitizer hold its output to. Shared by the attack tests and the property tests. */

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
