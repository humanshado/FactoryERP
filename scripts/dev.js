// npm run dev: the API (restarts on change) and the Vite dev server together
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const api = run('node', ['--no-warnings=ExperimentalWarning', '--watch-path=server', '--watch-path=shared', 'server/index.js']);
const web = run('npx', ['vite']);
const stop = () => { api.kill(); web.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
