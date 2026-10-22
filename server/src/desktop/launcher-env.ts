/**
 * Environment for the user's browser started by the desktop launcher: the launcher's own
 * environment without Steward's settings (SM_*, OTEL_*) and anything that looks like a credential –
 * the browser has no business seeing them (they would show up in its process environment).
 */
const SECRET = /SECRET|PASSW|PASSPHRASE|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|_KEY$|DSN|DATABASE_URL/i;

export function browserEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^SM_/i.test(k) && !/^OTEL_/i.test(k) && !SECRET.test(k)));
}
