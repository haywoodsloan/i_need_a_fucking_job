import { useCallback } from 'react';
import type { ParsedResume } from './resume/model';
import { ResumePage } from './ui/ResumePage';
import { SearchPage } from './ui/SearchPage';
import { useRoute, useStored } from './ui/hooks';

export const APP_NAME = 'Job Hunt';

export default function App() {
  const [route] = useRoute();
  const [resume, setResumeRaw] = useStored<ParsedResume | null>('resume:v1', null);
  const setResume = useCallback((r: ParsedResume | null) => setResumeRaw(r), [setResumeRaw]);

  return (
    <>
      <header className="topnav">
        <a className="brand" href="#/">
          {APP_NAME}
        </a>
        <nav aria-label="Main">
          <a href="#/" aria-current={route === '' ? 'page' : undefined}>
            Find jobs
          </a>
          <a href="#/resume" aria-current={route === 'resume' ? 'page' : undefined}>
            My resume
          </a>
        </nav>
      </header>
      {route === 'resume' ? <ResumePage resume={resume} setResume={setResume} /> : <SearchPage resume={resume} />}
    </>
  );
}
