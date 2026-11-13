import { describe, expect, it } from 'vitest';
import { labelOf, pickOptions, rememberLabels, searchTermOf } from '../../web/src/components/remoteSelect.js';

/**
 * Searchable pickers that ask the server as one types (0.20.0, web/src/components/remoteSelect.ts): the selected item's
 * label is never a search, and every id keeps one label – else the field flickers between "Gateway" and
 * "Gateway (server)" and asks the server every 250 ms.
 */
describe('server-searched pickers', () => {
  it('asks for what is typed, never for the selected item’s label', () => {
    expect(searchTermOf('', null)).toBe('');
    expect(searchTermOf(' gate ', null)).toBe('gate');
    expect(searchTermOf('Gateway (server · Invented AG)', 'Gateway (server · Invented AG)')).toBe('');
    expect(searchTermOf('Gateway (server · Invented AG) ', 'Gateway (server · Invented AG)')).toBe('');
    expect(searchTermOf('Gate', 'Gateway (server · Invented AG)')).toBe('Gate');
  });

  it('keeps one label per id: the first the server gave, else the fallback', () => {
    const memory = new Map<string, string>();
    expect(labelOf(memory, 'sys_1', 'Gateway')).toBe('Gateway');
    expect(labelOf(memory, 'sys_1')).toBe('sys_1');
    rememberLabels(memory, [{ value: 'sys_1', label: 'Gateway (server)' }]);
    rememberLabels(memory, [{ value: 'sys_1', label: 'Gateway' }]);
    expect(labelOf(memory, 'sys_1', 'Gateway')).toBe('Gateway (server)');
  });

  it('shows the selected item with its label, found or not – the label does not change with the search', () => {
    const memory = new Map<string, string>();
    const fallback = (id: string) => (id === 'sys_1' ? 'Gateway' : null);
    // nothing found yet: the selected one in front, with the fallback
    expect(pickOptions(memory, [], ['sys_1'], fallback)).toEqual([{ value: 'sys_1', label: 'Gateway' }]);
    // found with its detail: that label from now on
    expect(pickOptions(memory, [{ value: 'sys_1', label: 'Gateway (server)' }], ['sys_1'], fallback)).toEqual([{ value: 'sys_1', label: 'Gateway (server)' }]);
    // a search that does not find it: still the same label, in front of what was found
    expect(pickOptions(memory, [{ value: 'sys_2', label: 'Store (server)' }], ['sys_1'], fallback)).toEqual([
      { value: 'sys_1', label: 'Gateway (server)' },
      { value: 'sys_2', label: 'Store (server)' },
    ]);
    // an id nobody knows: the id itself
    expect(pickOptions(new Map(), [], ['sys_9'])).toEqual([{ value: 'sys_9', label: 'sys_9' }]);
  });
});
