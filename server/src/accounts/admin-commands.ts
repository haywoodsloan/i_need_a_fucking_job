/**
 * The admin commands, as plain functions that return the lines to print. `npm run admin` (cli.ts) runs them
 * directly when the server is stopped, and through the server's local admin channel when it is running.
 *
 * There is no admin screen in the app on purpose: creating an invite or a reset link takes access to the machine
 * the server runs on, not just a signed-in browser.
 */
import { INVITE_TTL_MS, RESET_TTL_MS, type AccountService } from './service';

export type AdminCommand =
  | { command: 'invite'; email: string; admin?: boolean }
  | { command: 'reset'; email: string }
  | { command: 'users' }
  | { command: 'sign-out'; email: string };

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** A time on this machine's clock, such as "2026-11-17 04:00". */
export const when = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const lasts = (ms: number) => (ms >= 48 * HOUR ? `${Math.round(ms / (24 * HOUR))} days` : `${Math.round(ms / HOUR)} hours`);

export async function runAdminCommand(service: AccountService, config: { origins: string[] }, c: AdminCommand): Promise<string[]> {
  const link = (kind: 'invite' | 'reset', code: string) => `${config.origins[0]}/#/${kind}/${code}`;
  switch (c?.command) {
    case 'invite': {
      const invite = await service.admin.invite(String(c.email ?? ''), c.admin ? 'admin' : 'user');
      return [
        `Invite for ${invite.email}${c.admin ? ' (admin)' : ''}, good for ${lasts(INVITE_TTL_MS)}:`,
        '',
        `  ${link('invite', invite.code)}`,
        '',
        'The link works once. Send it to them yourself: anyone who opens it first gets the account.',
      ];
    }
    case 'reset': {
      const reset = await service.admin.reset(String(c.email ?? ''));
      return [
        `Password reset for ${reset.email}, good for ${lasts(RESET_TTL_MS)}:`,
        '',
        `  ${link('reset', reset.code)}`,
        '',
        'Using this link erases the site logins stored in their account, because those can only be opened with the',
        'old password or the recovery code. If they still have their recovery code, they should use "Forgot your',
        'password?" on the sign-in page instead, which keeps everything.',
      ];
    }
    case 'users': {
      const users = await service.admin.users();
      if (!users.length) return ['No accounts yet. Create the first one with: npm run admin -- invite <email> --admin'];
      const width = Math.max(5, ...users.map((u) => u.email.length));
      return [
        `${'Email'.padEnd(width)}  Role   Created           Signed in`,
        ...users.map((u) => `${u.email.padEnd(width)}  ${u.role.padEnd(5)}  ${when(u.createdAt)}  ${u.sessions ? `${u.sessions} session${u.sessions === 1 ? '' : 's'}, last used ${when(u.lastSeenAt!)}` : 'no'}`),
      ];
    }
    case 'sign-out': {
      const ended = await service.admin.signOut(String(c.email ?? ''));
      return [`Signed ${c.email} out of ${ended} session${ended === 1 ? '' : 's'}.`];
    }
    default:
      throw new Error('Unknown admin command.');
  }
}
