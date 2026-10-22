#!/usr/bin/env node
/**
 * Checks that a commit message follows Conventional Commits (see CONTRIBUTING.md "Commits").
 * Runs as the commit-msg hook (.husky/commit-msg); no dependencies.
 *
 *   node scripts/commit-msg.mjs <file>     # the file git passes to the commit-msg hook (.git/COMMIT_EDITMSG)
 *
 * Accepted:  <type>(<optional scope>)!: <summary>   e.g. "fix(engine): keep the step order on resume"
 * Also:      "Merge …" (merge commits), "Revert "…"" (git revert), "fixup! …", "squash! …", "amend! …"
 *
 * Exit status: 0 = ok, 1 = the message does not follow the format, 2 = usage error.
 */
import fs from 'node:fs';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'];
const MAX_HEADER = 120;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(
    'Usage: node scripts/commit-msg.mjs <commit message file>\nChecks the message against Conventional Commits; see the comment at the top of the script.\n',
  );
  process.exit(0);
}
if (args.length !== 1) {
  process.stderr.write("error: pass the commit message file\nRun 'node scripts/commit-msg.mjs --help' for usage.\n");
  process.exit(2);
}

let text;
try {
  text = fs.readFileSync(args[0], 'utf8');
} catch (e) {
  process.stderr.write(`error: cannot read ${args[0]}: ${e.message}\n`);
  process.exit(2);
}

// What git removes before committing: everything below the scissors line (commit -v) and comment lines
const lines = text
  .replace(/\r\n/g, '\n')
  .split(/^# -+ >8 -+$/m)[0]
  .split('\n')
  .filter((l) => !l.startsWith('#'));
while (lines.length && !lines[0].trim()) lines.shift();
const header = lines[0]?.trimEnd() ?? '';

// Messages git writes itself, and autosquash markers
if (/^(Merge |Revert "|(fixup|squash|amend)! )/.test(header)) process.exit(0);

const problems = [];
const re = new RegExp(`^(?<type>[a-z]+)(?:\\((?<scope>[\\w$.,/ -]+)\\))?!?: (?<summary>\\S.*)$`);
const m = re.exec(header);
if (!header) problems.push('the message is empty');
else if (!m) problems.push('the first line must look like "<type>(<optional scope>): <summary>", e.g. "fix(engine): keep the step order on resume"');
else {
  if (!TYPES.includes(m.groups.type)) problems.push(`unknown type "${m.groups.type}" (use one of: ${TYPES.join(', ')})`);
  if (/[.]$/.test(m.groups.summary)) problems.push('the summary must not end with a period');
}
if (header.length > MAX_HEADER) problems.push(`the first line is ${header.length} characters long (at most ${MAX_HEADER})`);
if (lines.length > 1 && lines[1].trim()) problems.push('leave a blank line between the first line and the body');

if (problems.length) {
  process.stderr.write(
    `commit-msg: the commit message does not follow Conventional Commits (CONTRIBUTING.md):\n\n  ${header}\n\n` +
      problems.map((p) => `  - ${p}\n`).join('') +
      `\nYour message is saved in ${args[0]}. In an emergency, skip the hooks with: git commit --no-verify\n`,
  );
  process.exit(1);
}
