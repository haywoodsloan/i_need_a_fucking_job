/**
 * Account administration from the command line. There is no admin screen in the app: these commands need access to
 * the machine the server runs on.
 *
 *   npm run admin -- setup <email>           first-time setup, then prints an admin invite for that email
 *   npm run admin -- invite <email> [--admin]
 *   npm run admin -- reset <email>           a password reset link (erases their stored site logins)
 *   npm run admin -- users
 *   npm run admin -- sign-out <email>        sign someone out everywhere
 *
 * This file only starts accounts/cli.ts, so that a checkout where the account packages are not installed yet gets
 * one clear sentence instead of a stack trace.
 */
export {};

try {
  await import('./accounts/cli');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
  console.error(`Accounts need packages that are not installed yet. Run "npm install" in server/ and try again.\n(${(e as Error).message.split('\n')[0]})`);
  process.exitCode = 1;
}
