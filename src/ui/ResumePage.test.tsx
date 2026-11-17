/**
 * The resume page: adding a resume, then confirming, removing or correcting each thing that was read from it.
 * The rule under all of it is that a field is either the exact words of the file or words the user typed.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import basicResume from '../../test/fixtures/resumes/basic.txt?raw';
import { putFile } from '../lib/storage';
import { buildPdfSource, buildTextSource, type RawPdfItem } from '../resume/extract';
import { checkIntegrity, listFields, toApplicationProfile, updateField, type ParsedResume } from '../resume/model';
import { parseResume } from '../resume/parse';
import { ResumePage } from './ResumePage';

// The page image of a PDF is drawn by pdf.js, which needs a real browser. Here it is given a document with no pages
// to draw, so what is tested is this app's part: where the highlights go.
vi.mock('../resume/load', async (original) => ({
  ...(await original<typeof import('../resume/load')>()),
  loadPdfjs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }),
}));

const textFile = (content: string, name = 'jordan-rivera.txt') => new File([content], name, { type: 'text/plain' });
const parsedText = () => parseResume(buildTextSource(basicResume, { fileName: 'jordan-rivera.txt', mimeType: 'text/plain', kind: 'text', sha256: 'text-sha' }));

/** The page with the resume kept the way the app keeps it. `current()` is the resume as it now stands. */
function open(initial: ParsedResume | null = null) {
  let latest = initial;
  function Holder() {
    const [resume, setResume] = useState(initial);
    latest = resume;
    return <ResumePage resume={resume} setResume={setResume} />;
  }
  const user = userEvent.setup({ applyAccept: false });
  render(<Holder />);
  return { user, current: () => latest! };
}

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const fields = () => within(screen.getByRole('region', { name: 'Extracted fields' }));
const rows = () => [...document.querySelectorAll<HTMLElement>('.field')];
const row = (value: string) => {
  const found = rows().find((r) => r.querySelector('.value')?.textContent === value);
  if (!found) throw new Error(`No field on the page has the value "${value}"`);
  return found;
};
const active = () => document.querySelector('.field.active .value')?.textContent;
const field = (resume: ParsedResume, label: string) => listFields(resume).find((f) => f.label === label)!.field;

describe('adding a resume', () => {
  it('promises that the file stays in the browser and that only the user\'s own words are used', () => {
    open();
    expect(screen.getByRole('heading', { name: 'Add your resume' })).toBeInTheDocument();
    expect(screen.getByText(/Applications only ever use your own words, exactly as written\./)).toBeInTheDocument();
    expect(screen.getByText('PDF, DOCX or TXT. It stays in this browser and is never uploaded.')).toBeInTheDocument();
  });

  it('reads a chosen file into fields, none of them confirmed yet', async () => {
    const { user, current } = open();
    await user.upload(fileInput(), textFile(basicResume));

    expect(await screen.findByText('jordan-rivera.txt')).toBeInTheDocument();
    const total = listFields(current()).length;
    expect(screen.getByText(`0 of ${total} reviewed`)).toBeInTheDocument();
    expect(screen.getByText('Every field matches the source word for word')).toBeInTheDocument();
    expect(row('Jordan A. Rivera')).toHaveTextContent('Name');
    expect(row('jordan.rivera@example.com')).toHaveTextContent('Email');
    expect(fields().getByRole('heading', { name: 'Experience 1' })).toBeInTheDocument();
    expect(checkIntegrity(current())).toEqual([]);
    expect(current().source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('opens the file picker from the button', async () => {
    const { user } = open();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: 'Choose a file' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(fileInput()).toHaveAttribute('accept', expect.stringContaining('.pdf,.docx,.txt'));
  });

  it('reads a file that is dropped onto the page', async () => {
    open();
    fireEvent.drop(screen.getByRole('heading', { name: 'Add your resume' }).parentElement!, { dataTransfer: { files: [textFile(basicResume, 'dropped.txt')] } });
    expect(await screen.findByText('dropped.txt')).toBeInTheDocument();
  });

  it('says why a file cannot be read, and stays ready for another', async () => {
    const { user } = open();
    await user.upload(fileInput(), new File(['\xd0\xcf\x11\xe0'], 'resume.doc', { type: 'application/msword' }));
    expect(await screen.findByText('Old .doc files are not supported. Save it as .docx or PDF and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeEnabled();
  });

  it('says so when nothing could be read from the file', async () => {
    const { user } = open();
    await user.upload(fileInput(), textFile('   \n\n  ', 'empty.txt'));
    expect(await screen.findByText('Nothing could be read from this file. Try the Text view to see what was extracted.')).toBeInTheDocument();
    expect(screen.getByText('0 of 0 reviewed')).toBeInTheDocument();
  });
});

describe('reviewing what was read', () => {
  it('confirms a field, and takes the confirmation back when asked again', async () => {
    const { user, current } = open(parsedText());
    const name = row('Jordan A. Rivera');
    const confirm = within(name).getByRole('button', { name: 'Confirm' });

    await user.click(confirm);
    expect(confirm).toHaveAttribute('aria-pressed', 'true');
    expect(field(current(), 'Name').status).toBe('verified');
    expect(screen.getByText(/^1 of \d+ reviewed$/)).toBeInTheDocument();

    await user.click(confirm);
    expect(confirm).toHaveAttribute('aria-pressed', 'false');
    expect(field(current(), 'Name').status).toBe('pending');
  });

  it('removes a field, which then counts as reviewed and is struck out', async () => {
    const { user, current } = open(parsedText());
    const headline = row('Senior Software Engineer');
    await user.click(within(headline).getByRole('button', { name: 'Remove' }));

    expect(field(current(), 'Headline').status).toBe('rejected');
    expect(headline).toHaveClass('rejected');
    expect(screen.getByText(/^1 of \d+ reviewed$/)).toBeInTheDocument();
  });

  it('confirms a whole group at once, leaving what was removed as it is', async () => {
    const { user, current } = open(parsedText());
    await user.click(within(row('(512) 555-0142')).getByRole('button', { name: 'Remove' }));
    const contact = fields().getByRole('heading', { name: 'Contact' }).parentElement!;
    await user.click(within(contact).getByRole('button', { name: 'Confirm all' }));

    const statuses = listFields(current()).filter((f) => f.group === 'Contact').map((f) => [f.label, f.field.status]);
    expect(statuses).toEqual([
      ['Name', 'verified'],
      ['Headline', 'verified'],
      ['Email', 'verified'],
      ['Phone', 'rejected'],
      ['Location', 'verified'],
      ['Link 1', 'verified'],
      ['Link 2', 'verified'],
    ]);
    expect(listFields(current()).filter((f) => f.group !== 'Contact').every((f) => f.field.status === 'pending')).toBe(true);
    // Nothing is left to confirm in the group, so the button goes.
    expect(within(contact).queryByRole('button', { name: 'Confirm all' })).not.toBeInTheDocument();
  });

  it('shows how far the review has come, and goes to the next field that still needs it', async () => {
    const { user, current } = open(parsedText());
    const total = listFields(current()).length;
    await user.click(within(row('Jordan A. Rivera')).getByRole('button', { name: 'Confirm' }));
    await user.click(within(row('Senior Software Engineer')).getByRole('button', { name: 'Remove' }));

    expect(screen.getByText(`2 of ${total} reviewed`)).toBeInTheDocument();
    expect(screen.getByTitle(`1 confirmed, 1 removed, ${total - 2} to review`)).toBeInTheDocument();

    await user.click(row('Jordan A. Rivera'));
    await user.click(screen.getByRole('button', { name: /Next to review/ }));
    expect(active()).toBe('jordan.rivera@example.com');
  });
});

describe('reviewing with the keyboard', () => {
  it('moves with J and K, confirms with V, removes with X, and jumps to the next unreviewed field with N', async () => {
    const { user, current } = open(parsedText());
    expect(active()).toBe('Jordan A. Rivera');

    await user.keyboard('j');
    expect(active()).toBe('Senior Software Engineer');
    await user.keyboard('k');
    expect(active()).toBe('Jordan A. Rivera');

    // Confirming or removing moves on to the next field, so a resume can be gone through key by key.
    await user.keyboard('v');
    expect(field(current(), 'Name').status).toBe('verified');
    expect(active()).toBe('Senior Software Engineer');
    await user.keyboard('x');
    expect(field(current(), 'Headline').status).toBe('rejected');
    expect(active()).toBe('jordan.rivera@example.com');

    await user.keyboard('kk');
    expect(active()).toBe('Jordan A. Rivera');
    await user.keyboard('n');
    expect(active()).toBe('jordan.rivera@example.com');
  });

  it('goes round from the last field to the first', async () => {
    const { user, current } = open(parsedText());
    const all = listFields(current());
    await user.keyboard('k');
    expect(active()).toBe(all[all.length - 1].field.value);
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(all[0].field.value);
  });

  it('leaves the keys alone while a correction is being typed, or with Ctrl held', async () => {
    const { user, current } = open(parsedText());
    await user.keyboard('{Control>}v{/Control}');
    expect(field(current(), 'Name').status).toBe('pending');

    await user.keyboard('e');
    const box = within(row('Jordan A. Rivera')).getByRole('textbox');
    expect(box).toHaveFocus();
    await user.type(box, ' vxjk');
    expect(box).toHaveValue('Jordan A. Rivera vxjk');
    expect(field(current(), 'Name').status).toBe('pending');
    expect(row('Jordan A. Rivera')).toHaveClass('active');
  });
});

describe('correcting a field', () => {
  it('takes what the user types as the user\'s own words, marked as typed', async () => {
    const { user, current } = open(parsedText());
    await user.click(within(row('Senior Software Engineer')).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox');
    await user.clear(box);
    await user.type(box, '  Staff Engineer  {Enter}');

    expect(field(current(), 'Headline')).toMatchObject({ value: 'Staff Engineer', origin: 'user', spans: [], status: 'verified' });
    expect(row('Staff Engineer')).toHaveTextContent('typed');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // Typed words are not held to the file, so the resume still passes.
    expect(screen.getByText('Every field matches the source word for word')).toBeInTheDocument();
    expect(toApplicationProfile(current()).contact.headline).toBe('Staff Engineer');
  });

  it('saves when the box is left, and changes nothing with Escape', async () => {
    const { user, current } = open(parsedText());
    await user.click(within(row('Austin, TX')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox'), ' (remote){Escape}');
    expect(field(current(), 'Location')).toMatchObject({ value: 'Austin, TX', origin: 'source' });

    await user.click(within(row('Austin, TX')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox'), ' (remote)');
    await user.click(screen.getByText('What we read'));
    expect(field(current(), 'Location')).toMatchObject({ value: 'Austin, TX (remote)', origin: 'user' });
  });

  it('does not count an unchanged or emptied box as a correction', async () => {
    const { user, current } = open(parsedText());
    await user.click(within(row('Jordan A. Rivera')).getByRole('button', { name: 'Edit' }));
    await user.keyboard('{Enter}');
    expect(field(current(), 'Name')).toMatchObject({ value: 'Jordan A. Rivera', origin: 'source', status: 'pending' });

    await user.click(within(row('Jordan A. Rivera')).getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(field(current(), 'Name')).toMatchObject({ value: 'Jordan A. Rivera', origin: 'source' });
  });
});

describe('the resume beside the fields', () => {
  /** Selects `from`..`to` in the text of the resume, as a person would by dragging over it. */
  function select(resume: ParsedResume, from: string, to = from) {
    const text = resume.source.text;
    const start = text.indexOf(from);
    const end = text.indexOf(to) + to.length;
    const point = (offset: number, atEnd: boolean): [Node, number] => {
      const spans = [...document.querySelectorAll<HTMLElement>('.source-text [data-start]')];
      const span = spans.find((s) => {
        const base = Number(s.dataset.start);
        const length = s.textContent!.length;
        return atEnd ? offset > base && offset <= base + length : offset >= base && offset < base + length;
      })!;
      return [span.firstChild!, offset - Number(span.dataset.start)];
    };
    const range = document.createRange();
    range.setStart(...point(start, false));
    range.setEnd(...point(end, true));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(document.querySelector('.source-text')!);
  }

  it('shows the text of the file, and makes a field active when its words are clicked', async () => {
    const { user, current } = open(parsedText());
    const source = screen.getByRole('region', { name: 'Original resume' });
    expect(source.querySelector('.source-text')!.textContent).toBe(current().source.text);

    await user.click(within(source).getByText('jordan.rivera@example.com'));
    expect(active()).toBe('jordan.rivera@example.com');
    expect(within(source).getByText('jordan.rivera@example.com')).toHaveClass('active');
    expect(within(source).getByText('jordan.rivera@example.com')).toHaveAttribute('title', 'Email');
  });

  it('marks the words that ended up in no field', async () => {
    const { user } = open(parsedText());
    const unassigned = () => [...document.querySelectorAll('.source-text .unassigned')];
    const words = () => unassigned().map((el) => el.textContent!.trim());
    // In this resume only the joining word of "B.S. in Computer Science" belongs to no field.
    expect(words()).toEqual(['in']);

    await user.click(within(row('Senior Software Engineer')).getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Staff Engineer{Enter}');

    // The headline is now the user's typing, so its words in the file belong to no field any more.
    expect(words()).toEqual(['Senior Software Engineer', 'in']);
    expect(unassigned()[0]).toHaveAttribute('title', 'Not captured in any field');
  });

  it('lets the user point at the right words for a field, which are then taken exactly as written', async () => {
    const { user, current } = open(parsedText());
    await user.click(row('Senior Software Engineer'));

    select(current(), 'Backend engineer');
    expect(screen.getByText(/Use this text for/)).toHaveTextContent('Use this text for Headline');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Use' }));

    const headline = field(current(), 'Headline');
    const at = current().source.text.indexOf('Backend engineer');
    expect(headline).toMatchObject({ value: 'Backend engineer', origin: 'source', status: 'verified', spans: [{ start: at, end: at + 'Backend engineer'.length }] });
    expect(checkIntegrity(current())).toEqual([]);
    expect(screen.queryByText(/Use this text for/)).not.toBeInTheDocument();
  });

  it('keeps a selection that runs over two lines as one piece per line, without the spaces at its ends', async () => {
    const { user, current } = open(parsedText());
    await user.click(row('Senior Software Engineer'));

    select(current(), ' Designed the idempotency layer', 'Software Engineer | Jun 2018 ');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Use' }));

    const headline = field(current(), 'Headline');
    expect(headline.spans).toHaveLength(2);
    expect(headline.value).toBe('Designed the idempotency layer used by every payment endpoint. Software Engineer | Jun 2018');
    expect(checkIntegrity(current())).toEqual([]);
  });

  it('offers nothing for a click that selects nothing', async () => {
    const { user } = open(parsedText());
    await user.click(row('Senior Software Engineer'));
    window.getSelection()!.removeAllRanges();
    fireEvent.mouseUp(document.querySelector('.source-text')!);
    expect(screen.queryByText(/Use this text for/)).not.toBeInTheDocument();
  });
});

describe('a resume that fails the word-for-word check', () => {
  const tampered = () => {
    const resume = parsedText();
    return updateField(resume, listFields(resume).find((f) => f.label === 'Experience 1 · Title')!.path, { value: 'Principal Engineer' });
  };

  it('says how many fields differ and which, and cannot be exported', () => {
    open(tampered());
    const warning = screen.getByText('1 fields differ from the source');
    expect(warning).toHaveAttribute('title', 'Experience 1 · Title: Value differs from source text "Senior Software Engineer"');
    expect(screen.getByRole('button', { name: 'Export confirmed' })).toBeDisabled();
  });
});

describe('exporting, replacing and removing', () => {
  it('exports only what was confirmed, as a file named after the resume', async () => {
    const { user } = open(parsedText());
    const files: Blob[] = [];
    const names: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => (files.push(blob as Blob), 'blob:export'));
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await user.click(within(row('Jordan A. Rivera')).getByRole('button', { name: 'Confirm' }));
    await user.click(within(row('(512) 555-0142')).getByRole('button', { name: 'Remove' }));

    await user.click(screen.getByRole('button', { name: 'Export confirmed' }));

    expect(names).toEqual(['jordan-rivera-verified.json']);
    const exported = JSON.parse(await files[0].text());
    expect(exported.contact).toEqual({ name: 'Jordan A. Rivera', links: [] });
    expect(exported.sourceSha256).toBe('text-sha');
    expect(exported.summary).toEqual([]);
  });

  it('asks before removing the resume, and keeps it when the answer is no', async () => {
    const { user, current } = open(parsedText());
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Remove', description: '' }));
    expect(ask).toHaveBeenCalledWith('Remove this resume from this browser?');
    expect(current()).not.toBeNull();

    ask.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Remove', description: '' }));
    expect(await screen.findByRole('heading', { name: 'Add your resume' })).toBeInTheDocument();
    expect(current()).toBeNull();
  });

  it('replaces the resume with another file, starting its review afresh', async () => {
    const { user, current } = open(parsedText());
    await user.click(within(row('Jordan A. Rivera')).getByRole('button', { name: 'Confirm' }));

    await user.upload(fileInput(), textFile('Sam Okafor\nsam.okafor@example.com\n\nSKILLS\nSQL, Python', 'sam-okafor.txt'));

    expect(await screen.findByText('sam-okafor.txt')).toBeInTheDocument();
    expect(row('Sam Okafor')).toHaveTextContent('Name');
    expect(screen.getByText(/^0 of \d+ reviewed$/)).toBeInTheDocument();
    expect(current().source.fileName).toBe('sam-okafor.txt');
    expect(screen.queryByText('Jordan A. Rivera')).not.toBeInTheDocument();
  });
});

describe('a PDF resume', () => {
  /** A run of 10pt text as pdf.js reports it. y is measured up from the bottom of the page. */
  const run = (str: string, x: number, y: number): RawPdfItem => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 });
  const parsedPdf = () =>
    parseResume(
      buildPdfSource(
        [
          {
            width: 612,
            height: 792,
            items: [run('Sam Okafor', 50, 750), run('sam.okafor@example.com', 50, 730), run('SKILLS', 50, 700), run('SQL, Python', 50, 680)],
          },
        ],
        { fileName: 'sam-okafor.pdf', mimeType: 'application/pdf', sha256: 'pdf-sha' },
      ),
    );

  it('falls back to the text when the original file is no longer in this browser', async () => {
    const { user } = open(parsedPdf());
    expect(await screen.findByText(/The original file isn't stored in this browser any more\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Show text view' }));

    expect(document.querySelector('.source-text')!.textContent).toBe('Sam Okafor\nsam.okafor@example.com\nSKILLS\nSQL, Python');
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('lays a highlight over each field where it sits on the page, and none over a removed field', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await putFile('pdf-sha', new Uint8Array([37, 80, 68, 70]).buffer);
    const { user } = open(parsedPdf());

    await waitFor(() => expect(document.querySelectorAll('.pdf-page .hl').length).toBeGreaterThan(0));
    const highlight = (title: string) => document.querySelector<HTMLElement>(`.pdf-page .hl[title="${title}"]`);
    // The email is 22 characters of 5pt each, starting 50pt in on a page 612pt wide, 730pt up a page 792pt high.
    expect(highlight('Email')!.style.left).toBe(`${(50 / 612) * 100}%`);
    expect(highlight('Email')!.style.width).toBe(`${(110 / 612) * 100}%`);
    expect(highlight('Email')!.style.top).toBe(`${((792 - 730 - 8) / 792) * 100}%`);
    // One run of text can hold several fields. Each gets its own share of the run.
    expect(highlight('Skills 1 · 1')!.style.width).toBe(`${(15 / 612) * 100}%`);
    expect(highlight('Skills 1 · 2')!.style.left).toBe(`${(75 / 612) * 100}%`);

    await user.click(highlight('Email')!);
    expect(active()).toBe('sam.okafor@example.com');
    expect(highlight('Email')).toHaveClass('active');

    await user.click(within(row('sam.okafor@example.com')).getByRole('button', { name: 'Remove' }));
    expect(highlight('Email')).toBeNull();
  });
});
