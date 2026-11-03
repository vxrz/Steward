// ESLint rules for errors that are caught and dropped (eslint.config.js). A failure that is ignored on purpose says
// why; one that someone should see is logged instead (logger.debug / logger.warn on the server).
//
//   catch-reason/empty-catch   an empty catch block needs a comment that gives a reason – "/* ignore */" is none
//                              (ESLint's no-empty already refuses a catch block without any comment)
//   catch-reason/noop-catch    .catch(() => undefined), .catch(() => {}), .catch(() => null) need a comment on the
//                              same line or the line above that says why the failure does not matter
//
// A reason has at least two words, e.g. "/* already closed */", "// best effort: the next tick retries".

const TRIVIAL = /^(ignored?|ignore it|nothing|noop|no-op|empty|todo|ok|fine|skip|swallow(ed)?|intentional|expected|-+)\.?$/i;

/** A comment text that explains something: two words or more, not a placeholder. */
function isReason(text) {
  const t = text
    .replace(/^\s*\*+/gm, '')
    .replace(/eslint-disable.*$/, '')
    .trim();
  if (!t || TRIVIAL.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= 2;
}

const emptyCatch = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require a reason in a comment of every empty catch block' },
    schema: [],
    messages: {
      reason: 'Say why this error can be ignored ("/* already gone */"), or log it (logger.debug/warn) – "{{text}}" is no reason.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CatchClause(node) {
        if (node.body.body.length) return;
        const comments = source.getCommentsInside(node.body);
        if (!comments.length) return; // no-empty reports it
        const text = comments.map((c) => c.value).join(' ');
        if (!isReason(text)) context.report({ node: node.body, messageId: 'reason', data: { text: text.trim().slice(0, 40) } });
      },
    };
  },
};

/** () => undefined | () => {} | () => null | () => void 0 */
function isNoop(fn) {
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') || fn.params.length) return false;
  const b = fn.body;
  if (b.type === 'BlockStatement') return b.body.length === 0;
  if (b.type === 'Identifier') return b.name === 'undefined';
  if (b.type === 'Literal') return b.value === null;
  return b.type === 'UnaryExpression' && b.operator === 'void' && b.argument.type === 'Literal';
}

const noopCatch = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require a reason next to .catch(() => undefined) and other handlers that drop the error' },
    schema: [],
    messages: {
      reason: 'This .catch drops the error: add a comment on this line or the line above saying why that is fine, or log it.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    let commentLines;
    const lines = () => {
      if (!commentLines) {
        commentLines = new Map();
        for (const c of source.getAllComments()) {
          if (!isReason(c.value)) continue;
          for (let l = c.loc.start.line; l <= c.loc.end.line; l++) commentLines.set(l, true);
        }
      }
      return commentLines;
    };
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'catch' || node.arguments.length !== 1) return;
        const fn = node.arguments[0];
        if (!isNoop(fn)) return;
        // a comment inside the empty block counts too: .catch(() => { /* closed already */ })
        if (fn.body.type === 'BlockStatement' && source.getCommentsInside(fn.body).some((c) => isReason(c.value))) return;
        const line = callee.property.loc.start.line;
        // the statement this call is part of: a comment on the line above it explains the whole statement
        let stmt = node;
        while (stmt.parent && !/Statement$|Declaration$/.test(stmt.parent.type)) stmt = stmt.parent;
        const first = (stmt.parent ?? stmt).loc.start.line;
        const known = lines();
        if ([first - 1, line - 1, line, fn.loc.end.line].some((l) => known.has(l))) return;
        context.report({ node: callee.property, messageId: 'reason' });
      },
    };
  },
};

export default { rules: { 'empty-catch': emptyCatch, 'noop-catch': noopCatch } };
