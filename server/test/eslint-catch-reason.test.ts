import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
// @ts-expect-error – a plain JavaScript module (scripts/eslint/catch-reason.js)
import plugin from '../../scripts/eslint/catch-reason.js';

// RuleTester calls describe/it itself
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } });

describe('ESLint: dropped errors say why (scripts/eslint/catch-reason.js)', () => {
  tester.run('empty-catch', plugin.rules['empty-catch'], {
    valid: [
      'try { f(); } catch { /* already closed */ }',
      'try { f(); } catch (e) { log(e); }',
      'function g() { try { f(); } catch { return null; } }',
      'try { f(); } catch {}', // no comment at all: no-empty reports it
    ],
    invalid: [
      { code: 'try { f(); } catch { /* ignore */ }', errors: [{ messageId: 'reason' }] },
      { code: 'try { f(); } catch { /* missing */ }', errors: [{ messageId: 'reason' }] },
      { code: 'try { f(); } catch {\n  // ignored\n}', errors: [{ messageId: 'reason' }] },
    ],
  });
  tester.run('noop-catch', plugin.rules['noop-catch'], {
    valid: [
      'p.catch((e) => log(e));',
      'p.catch(() => fallback);',
      'p.catch(() => undefined); // the body is not read any more',
      '// best effort: the process ends anyway\nawait p.catch(() => undefined);',
      'p.catch(() => { /* closed meanwhile */ });',
    ],
    invalid: [
      { code: 'p.catch(() => undefined);', errors: [{ messageId: 'reason' }] },
      { code: 'p.catch(() => {});', errors: [{ messageId: 'reason' }] },
      { code: 'p.catch(() => null);', errors: [{ messageId: 'reason' }] },
      { code: 'p.catch(() => undefined); // ignore', errors: [{ messageId: 'reason' }] },
    ],
  });
});
