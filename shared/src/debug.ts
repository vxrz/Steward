import { isMutating, type FlowNode } from './process.js';
import type { DebugAnswers } from './api.js';

/**
 * Which answers a node can run with in a single-node debug run (ADR 0010) – the same rules in the editor and on the
 * server. A refusal is a reason code the UI translates.
 */

/** Page interactions of a browser step: a live read never performs them. */
export const BROWSER_INTERACTIONS = ['click', 'fill', 'press', 'select', 'check', 'evaluate'] as const;

/** The node calls a platform (its answers default to recorded ones). */
export function callsPlatform(node: FlowNode): boolean {
  return ['http', 'query', 'ai', 'browser', 'subprocess', 'contractTest', 'accessChange'].includes(node.type);
}

export type DebugAnswerRefusal = 'writes' | 'interacts' | 'noPlatform' | 'needsAnswer' | 'needsRecording' | null;

/** Why `node` cannot run with these answers, or null. `pasted`: the request brings a pasted answer. */
export function debugAnswerRefusal(node: FlowNode, answers: DebugAnswers, pasted = false): DebugAnswerRefusal {
  if (answers === 'live') {
    switch (node.type) {
      case 'http':
        // a step's mutating: false does not make a POST live-able (as for read-only identities, ADR 0009)
        return ['GET', 'HEAD'].includes(node.method) && !isMutating({ method: node.method }) ? null : 'writes';
      case 'query':
      case 'ai':
        return null;
      case 'browser':
        return node.mutating || node.actions.some((a) => (BROWSER_INTERACTIONS as readonly string[]).includes(a.action)) ? 'interacts' : null;
      case 'subprocess':
      case 'contractTest':
      case 'accessChange':
        return 'writes';
      default:
        return 'noPlatform';
    }
  }
  if (answers === 'offline') {
    switch (node.type) {
      case 'http':
        return pasted ? null : 'needsAnswer';
      case 'ai':
        return node.sampleAnswer !== undefined ? null : 'needsAnswer';
      case 'query':
      case 'browser':
      case 'subprocess':
      case 'contractTest':
        return 'needsRecording';
      default:
        return null;
    }
  }
  return null;
}

/** The answers a node runs with when none are chosen: recorded for a node that calls a platform, else offline. */
export const defaultDebugAnswers = (node: FlowNode): DebugAnswers => (callsPlatform(node) ? 'recorded' : 'offline');
