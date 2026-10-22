// Starts the API server (auto-reload) and the Vite dev server together.
import { spawn } from 'node:child_process';
import { npmCommand } from './npm-command.mjs';

const procs = [
  ['server', ['run', 'dev', '-w', 'server']],
  ['web', ['run', 'dev', '-w', 'web']],
].map(([name, args]) => {
  // no shell, also on Windows (npm-command.mjs)
  const [cmd, argv] = npmCommand(args);
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = name === 'server' ? '\x1b[36m[server]\x1b[0m ' : '\x1b[35m[web]\x1b[0m    ';
  const pipe = (stream, out) => stream.on('data', (d) => out.write(d.toString().replace(/^(?=.)/gm, prefix)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}exited with ${code}`);
    procs.forEach((x) => x.kill());
    process.exit(code ?? 0);
  });
  return p;
});
console.log('Open http://127.0.0.1:5173 (UI with hot reload). API on http://127.0.0.1:4310.');
process.on('SIGINT', () => procs.forEach((p) => p.kill('SIGINT')));
