/**
 * Loads server/.env when it exists, so `npm start`, `npm run dev` and `npm run smoke` pick up local keys without
 * extra flags. Import this before anything that reads process.env. Hosted deployments have no .env file and set
 * real environment variables instead, which always win over the file.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(file)) process.loadEnvFile(file);
