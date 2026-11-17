/**
 * A real Word file through the real Word reader (mammoth), then through the app's own reading of a resume.
 *
 * The unit tests of `docxHtmlToText` use HTML typed by hand. This checks the assumption under them: what mammoth
 * really makes of headings, tables and lists. The first version of this test found that mammoth wraps the text of
 * every table cell in a paragraph, which put each cell of a row on its own line.
 *
 * The app loads mammoth's browser build, which takes `arrayBuffer`. Node's build takes `buffer`, and that is the
 * only difference here. The browser build itself is run by test/e2e/app.e2e.ts.
 */
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { buildTextSource, docxHtmlToText } from '../../src/resume/extract';
import { checkIntegrity, listFields, sourceCoverage } from '../../src/resume/model';
import { parseResume } from '../../src/resume/parse';
import { RESUME, resumeDocx } from '../helpers/resume-files';

describe('a Word resume', () => {
  it('is read by mammoth without complaint, into the HTML the app expects', async () => {
    const { value, messages } = await mammoth.convertToHtml({ buffer: Buffer.from(resumeDocx()) });
    expect(messages).toEqual([]);
    expect(value).toContain(`<h1>${RESUME.name}</h1>`);
    expect(value).toContain(`<td><p>${RESUME.email}</p></td><td><p>${RESUME.phone}</p></td>`);
    expect(value).toContain(`<ul><li>${RESUME.bullets[0]}</li><li>${RESUME.bullets[1]}</li></ul>`);
  });

  it('becomes the lines a person sees, with a table row on one line', async () => {
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(resumeDocx()) });
    expect(docxHtmlToText(value).split('\n').filter(Boolean)).toEqual([
      RESUME.name,
      `${RESUME.email}   ${RESUME.phone}   ${RESUME.location}`,
      'EXPERIENCE',
      `${RESUME.title}, ${RESUME.company}   ${RESUME.dates}`,
      `• ${RESUME.bullets[0]}`,
      `• ${RESUME.bullets[1]}`,
      'EDUCATION',
      RESUME.school,
      RESUME.degree,
      'SKILLS',
      RESUME.skills.join(', '),
    ]);
  });

  it('is read into the right fields, each the exact words of the file', async () => {
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(resumeDocx()) });
    const resume = parseResume(buildTextSource(docxHtmlToText(value), { fileName: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx', sha256: 'x' }));

    expect(Object.fromEntries(listFields(resume).map((f) => [f.label, f.field.value]))).toEqual({
      Name: RESUME.name,
      Email: RESUME.email,
      Phone: RESUME.phone,
      Location: RESUME.location,
      'Experience 1 · Title': RESUME.title,
      'Experience 1 · Company': RESUME.company,
      'Experience 1 · Dates': RESUME.dates,
      'Experience 1 · Bullet 1': RESUME.bullets[0],
      'Experience 1 · Bullet 2': RESUME.bullets[1],
      'Education 1 · Institution': RESUME.school,
      'Education 1 · Degree': 'Bachelor of Science',
      'Education 1 · Field of study': 'Statistics',
      'Education 1 · Dates': '2019',
      'Skills 1 · 1': RESUME.skills[0],
      'Skills 1 · 2': RESUME.skills[1],
      'Skills 1 · 3': RESUME.skills[2],
      'Skills 1 · 4': RESUME.skills[3],
    });
    expect(checkIntegrity(resume)).toEqual([]);
    expect(sourceCoverage(resume)).toBeGreaterThan(0.97);
  });
});
