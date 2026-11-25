/**
 * The copy of the app on a static host (the public demo) has no server of its own. So it has no tracker, and it
 * never asks for one.
 *
 * Whether a copy looks for a tracker is settled once, when the app loads (client.ts). In every other component
 * test the app is loaded the way local development loads it, where it does look. Here it is loaded afresh the way
 * a build for a static host is: not in development, and on a page that no server marked. What the app does where
 * there is a tracker is in src/ui/ApplicationsPage.test.tsx.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

async function openStaticCopy(address: string) {
  vi.resetModules();
  vi.stubEnv('DEV', false);
  const { openApp } = await import('../testing/openApp');
  return openApp(address);
}

describe('a copy of the app that has no server of its own', () => {
  it('has no applications, says so at their address, and asks no server for them', async () => {
    const { server } = await openStaticCopy('/applications');

    expect(screen.getByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    expect(screen.getByText('This copy of the app keeps no applications.')).toBeInTheDocument();
    expect(screen.getByText(/Start the app on your computer with "npm run local" to track your applications\./)).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link').map((a) => a.textContent)).toEqual(['Find jobs', 'My resume']);

    // Not when the page opens, and not when the window comes back into view.
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(server.calls).toEqual([]);
  });
});
