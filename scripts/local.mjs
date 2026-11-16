// Runs the whole app on this machine: the search backend and the frontend, wired together.
//   npm run local        then open http://localhost:5173
// Keys and switches for the backend live in server/.env (see server/.env.example). Stop both with Ctrl+C.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.PORT || '8787';
const api = process.env.VITE_API_URL || `http://localhost:${port}`;

let stopping = false;
const children = [];
children.push(
  start('backend', 'npm start', { cwd: `${root}/server`, env: { ...process.env, PORT: port } }),
  start('frontend', 'npm run dev', { cwd: root, env: { ...process.env, VITE_API_URL: api } }),
);

function start(name, command, opts) {
  const child = spawn(command, { stdio: 'inherit', shell: true, ...opts });
  child.on('exit', (code) => {
    if (!stopping) console.log(`\nThe ${name} stopped${code ? ` (exit code ${code})` : ''}, so the other one is being stopped too.`);
    stop(code ?? 0);
  });
  return child;
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    // On Windows the child is a shell wrapping npm wrapping node: end the whole tree, not just the shell.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));
console.log(`Starting the backend on http://localhost:${port} and the frontend (Vite prints its address below).\n`);
