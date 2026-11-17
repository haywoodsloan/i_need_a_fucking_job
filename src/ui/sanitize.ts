/**
 * Job descriptions come from third-party sites, so their HTML is rebuilt
 * from an allowlist before rendering. Optionally wraps the user's skills in
 * <mark> so they can see at a glance how a posting matches their resume.
 */
const ALLOWED = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'U', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'DIV', 'SPAN', 'TABLE', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH']);

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function termsRegex(terms: string[]): RegExp | undefined {
  const t = [...new Set(terms.map((x) => x.trim()).filter((x) => x.length >= 2 && x.length <= 40))].sort((a, b) => b.length - a.length);
  if (!t.length) return undefined;
  return new RegExp(`(?<![\\w+#])(${t.map(escapeRe).join('|')})(?![\\w+#])`, 'gi');
}

export function sanitizeHtml(html: string, highlight?: RegExp): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createElement('div');
  const walk = (src: Node, dst: Node) => {
    for (const child of [...src.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        appendText(dst, child.textContent ?? '', highlight);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        // SVG and MathML elements give their names in lower case, so compare in upper case: an <svg> and everything
        // in it is dropped, like the other tags in DROP.
        const tag = el.tagName.toUpperCase();
        if (DROP.has(tag)) continue;
        if (el.namespaceURI !== HTML_NAMESPACE || !ALLOWED.has(tag)) {
          walk(el, dst);
          continue;
        }
        const copy = document.createElement(tag.toLowerCase());
        if (tag === 'A') {
          const href = el.getAttribute('href') ?? '';
          if (/^https?:\/\//i.test(href)) {
            copy.setAttribute('href', href);
            copy.setAttribute('target', '_blank');
            copy.setAttribute('rel', 'noopener noreferrer nofollow');
          }
        }
        walk(el, copy);
        dst.appendChild(copy);
      }
    }
  };
  walk(doc.body, out);
  return out.innerHTML;
}

export function textToHtml(text: string, highlight?: RegExp): string {
  const out = document.createElement('div');
  for (const para of text.split(/\n{2,}/)) {
    const p = document.createElement('p');
    para.split('\n').forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'));
      appendText(p, line, highlight);
    });
    out.appendChild(p);
  }
  return out.innerHTML;
}

function appendText(dst: Node, text: string, re?: RegExp) {
  if (!re) {
    dst.appendChild(document.createTextNode(text));
    return;
  }
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    dst.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    dst.appendChild(mark);
    last = m.index + m[0].length;
  }
  dst.appendChild(document.createTextNode(text.slice(last)));
}
