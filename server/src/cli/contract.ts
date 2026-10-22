/**
 * Sandbox contract test for CI: asks a running Steward to call the
 * documented GET operations of a platform and compare them with its OpenAPI
 * specifications. Exits non-zero when an operation fails.
 *
 *   npm run contract -- --url http://127.0.0.1:4310 --token smt_... --platform <id>
 *   (or SM_URL / SM_TOKEN / SM_PLATFORM environment variables; --json prints the raw result)
 */
import type { ContractCheckResult } from '@sm/shared';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1];
}

async function main(): Promise<number> {
  const url = (arg('url') ?? process.env.SM_URL ?? 'http://127.0.0.1:4310').replace(/\/+$/, '');
  const token = arg('token') ?? process.env.SM_TOKEN;
  const platform = arg('platform') ?? process.env.SM_PLATFORM;
  if (!token || !platform) {
    console.error('Usage: npm run contract -- --url http://127.0.0.1:4310 --token smt_... --platform <platform id> [--json]');
    return 2;
  }
  let res: Response;
  try {
    res = await fetch(`${url}/api/platforms/${encodeURIComponent(platform)}/contract-check`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-sm-client': '1', 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (e) {
    console.error(`✘ Cannot reach ${url}: ${(e as Error).message}`);
    return 2;
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`✘ HTTP ${res.status}: ${text.slice(0, 500)}`);
    return 2;
  }
  const r = JSON.parse(text) as ContractCheckResult;
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.results) {
      console.log(`${x.ok ? '✔' : '✘'} ${x.method} ${x.path}${x.operationId ? ` (${x.operationId})` : ''} → ${x.status || 'error'}`);
      for (const p of x.problems) console.log(`    ${p}`);
    }
    console.log(`\n${r.checked} checked, ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`);
  }
  if (r.checked === 0) console.warn('No GET operations without path parameters found – import an OpenAPI specification first.');
  return r.failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
