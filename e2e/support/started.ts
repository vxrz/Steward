import type { ChildProcess } from 'node:child_process';

/**
 * Waits for the "service manager started" line (JSON log, server/src/main.ts) of this server process and returns the
 * address it listens on – the real port also with SM_PORT=0 (#22). A health check against a URL could reach another
 * process that holds the port; the start line can only come from our own child. Needs SM_LOG_LEVEL info or lower.
 */
export function waitForStart(child: ChildProcess, opts: { timeoutMs?: number; log?: () => string } = {}): Promise<{ url: string; port: number }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const done = (err: Error | null, value?: { url: string; port: number }) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('close', onClose);
      if (err) reject(err);
      else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.includes('"service manager started"')) continue;
        try {
          const url = (JSON.parse(line) as { url: string }).url;
          return done(null, { url, port: Number(new URL(url).port) });
        } catch {
          /* not the JSON line */
        }
      }
    };
    const onClose = (code: number | null) => done(new Error(`server exited with code ${code} before it started${opts.log ? `: ${opts.log()}` : ''}`));
    const timer = setTimeout(() => done(new Error(`server did not start within ${timeoutMs / 1000} s${opts.log ? `: ${opts.log()}` : ''}`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.on('close', onClose);
  });
}
