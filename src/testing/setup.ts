/**
 * Setup for component tests (the `ui` project in vitest.config.ts): the matchers that read like the page
 * (`toBeInTheDocument`, `toBeDisabled`, ...), a clean page and clean browser storage for every test, and stand-ins
 * for the few browser features jsdom does not have.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = '';
});

// jsdom lays nothing out, so the calls that only make sense on a drawn page do nothing and measure nothing.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

// jsdom's File and Blob cannot hand over their content the way browsers do now. They can through FileReader.
function readBlob<T>(blob: Blob, start: (reader: FileReader) => void, result: (reader: FileReader) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(result(reader));
    reader.onerror = () => reject(reader.error);
    start.call(blob, reader);
  });
}
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    // Copied, so the bytes are an ordinary ArrayBuffer and not one that belongs to jsdom's own window.
    return readBlob(this, (r) => r.readAsArrayBuffer(this), (r) => new Uint8Array(r.result as ArrayBuffer).slice().buffer);
  };
}
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function (this: Blob) {
    return readBlob(this, (r) => r.readAsText(this), (r) => r.result as string);
  };
}
