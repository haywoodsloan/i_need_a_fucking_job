/** Opens the whole app at an address, against the stand-in server, for tests that follow a person through it. */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { fakeAccounts, type FakeAccountsOptions } from './fakeAccounts';
import type { Route } from './fakeServer';

export const SAM = { email: 'sam@example.com', password: 'correct horse battery staple', recoveryCode: 'OLD1-AAAA-BBBB-CCCC-DDDD-EEEE' };

/**
 * `address` is the part after the "#", e.g. "/sign-in". The app asks the server who is signed in as soon as it
 * opens, so `options` says what the server will answer. It also asks whether the server keeps applications. The
 * answer is no, unless `routes` holds the routes of a tracker (src/testing/fakeTracker.ts).
 */
export function openApp(address: string, options: FakeAccountsOptions = {}, routes: Record<string, Route> = {}) {
  window.location.hash = address;
  const accounts = fakeAccounts(options, { 'GET /api/applications': () => ({ available: false, applications: [] }), ...routes });
  const user = userEvent.setup();
  const page = render(<App />);
  return { ...accounts, user, page };
}
