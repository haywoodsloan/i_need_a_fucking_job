import { useCallback } from 'react';
import { AccountProvider, useAccount } from './account/AccountProvider';
import { TrackerProvider, useTracker } from './apply/TrackerProvider';
import type { ParsedResume } from './resume/model';
import { AccountPage } from './ui/AccountPage';
import { ApplicationsPage } from './ui/ApplicationsPage';
import { ResumePage } from './ui/ResumePage';
import { SearchPage } from './ui/SearchPage';
import { LinkPage, RecoverPage, SignInPage } from './ui/SignInPages';
import { useRoute, useStored } from './ui/hooks';

export const APP_NAME = 'Job Hunt';

export default function App() {
  return (
    <AccountProvider>
      <TrackerProvider>
        <Shell />
      </TrackerProvider>
    </AccountProvider>
  );
}

function Shell() {
  const [route] = useRoute();
  // "invite/<code>" and "reset/<code>" carry a one-time code after the page name, and "applications/<id>" names one
  // application.
  const [page, code = ''] = route.split('/');
  const account = useAccount().state.status;
  const tracker = useTracker().state.status;
  const [resume, setResumeRaw] = useStored<ParsedResume | null>('resume:v1', null);
  const setResume = useCallback((r: ParsedResume | null) => setResumeRaw(r), [setResumeRaw]);
  const onAccountPage = ['account', 'sign-in', 'invite', 'reset', 'recover'].includes(page);

  return (
    <>
      <header className="topnav">
        <a className="brand" href="#/">
          {APP_NAME}
        </a>
        <nav aria-label="Main">
          <a href="#/" aria-current={page === '' ? 'page' : undefined}>
            Find jobs
          </a>
          {/* Only where the app's own server keeps applications: the public demo has no server. */}
          {tracker === 'on' && (
            <a href="#/applications" aria-current={page === 'applications' ? 'page' : undefined}>
              Applications
            </a>
          )}
          <a href="#/resume" aria-current={page === 'resume' ? 'page' : undefined}>
            My resume
          </a>
          {/* Only where there is an account server to talk to: the public demo has none. */}
          {account === 'signed-in' && (
            <a href="#/account" aria-current={onAccountPage ? 'page' : undefined}>
              Account
            </a>
          )}
          {account === 'signed-out' && (
            <a href="#/sign-in" aria-current={onAccountPage ? 'page' : undefined}>
              Sign in
            </a>
          )}
        </nav>
      </header>
      {page === 'resume' ? (
        <ResumePage resume={resume} setResume={setResume} />
      ) : page === 'applications' ? (
        <ApplicationsPage id={code} />
      ) : page === 'account' ? (
        <AccountPage />
      ) : page === 'sign-in' ? (
        <SignInPage />
      ) : page === 'invite' || page === 'reset' ? (
        <LinkPage key={code} code={code} />
      ) : page === 'recover' ? (
        <RecoverPage />
      ) : (
        <SearchPage resume={resume} />
      )}
    </>
  );
}
