// Server entry for `npm start` / `npm run dev` and the bundle (server/dist/index.js, the container image).
// The desktop executable uses desktop/launcher.ts.
let start: (typeof import('./main.js'))['start'];
try {
  ({ start } = await import('./main.js'));
} catch (e) {
  // config.ts validates every SM_* variable when it is loaded: print the list of bad variables, no stack trace
  if (e instanceof Error && e.name === 'ConfigError') {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
await start();

export {};
