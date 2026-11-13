// Loaded (--import) into the server processes the tests start (server-process.ts). Their standard input is a pipe from
// the test worker: when the worker ends – also when it is killed and cannot clean up (out of memory, a hook time-out
// that ends the worker) – the pipe closes and the server stops at once, so no test server outlives its test file.
if (process.env.SM_TEST_EXIT_WITH_PARENT === '1') {
  const stop = () => process.kill(process.pid, 'SIGKILL');
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
  // the server's own work keeps it running, not this pipe: a server that ends by itself still ends
  process.stdin.unref?.();
}
