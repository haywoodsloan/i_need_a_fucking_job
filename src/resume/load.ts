/**
 * Browser-side file loaders. pdf.js and mammoth are loaded lazily so the job
 * search page doesn't pay for them.
 */
import { buildPdfSource, buildTextSource, docxHtmlToText, sha256Hex, type RawPdfPage } from './extract';
import type { SourceDocument } from './model';

export const ACCEPTED = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

export async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

export async function fileToSource(file: File): Promise<{ source: SourceDocument; bytes: ArrayBuffer }> {
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const name = file.name.toLowerCase();
  const meta = { fileName: file.name, mimeType: file.type || 'application/octet-stream', sha256 };

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    const pages: RawPdfPage[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        width: vp.width,
        height: vp.height,
        items: content.items
          .filter((it): it is Extract<typeof it, { str: string }> => 'str' in it)
          .map((it) => ({ str: it.str, transform: it.transform, width: it.width, height: it.height })),
      });
    }
    const source = buildPdfSource(pages, meta);
    if (!source.text.trim()) {
      throw new Error('This PDF has no selectable text (it may be a scanned image). Export it from your editor as a text PDF or DOCX.');
    }
    return { source, bytes };
  }

  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes });
    return { source: buildTextSource(docxHtmlToText(value), { ...meta, kind: 'docx' }), bytes };
  }

  if (name.endsWith('.doc')) {
    throw new Error('Old .doc files are not supported. Save it as .docx or PDF and try again.');
  }

  const text = new TextDecoder().decode(bytes);
  return { source: buildTextSource(text, { ...meta, kind: 'text' }), bytes };
}
