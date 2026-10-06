import {describe, expect, it} from 'vitest';
import type {RedactionRule} from '../src/shared/types';
import {redactHeaders, redactStored, redactTree, parseBody} from '../src/server/redact';

const r = (rule: Partial<RedactionRule> & {scope: RedactionRule['scope']; target: string; action: RedactionRule['action']}): RedactionRule =>
  ({id: Math.random().toString(36).slice(2), ...rule});

describe('redactTree', () => {
  it('supports drops, replacements and tails, including dotted keys and indices', () => {
    const tree = {
      card: {number: '4111111111111111', brand: 'visa'},
      phones: ['13800001234', '13900005678'],
      'weird.key': 'token-abc',
      keep: 'visible',
    };
    const rules = [
      r({scope: 'body', target: 'card.number', action: 'tail', keepLast: 4}),
      r({scope: 'body', target: 'card.brand', action: 'drop'}),
      r({scope: 'body', target: 'phones[0]', action: 'drop'}),
      r({scope: 'body', target: '["weird.key"]', action: 'replace', replacement: '***'}),
    ];
    const out = redactTree(tree, rules);
    expect(out.card.number).toBe('1111');
    expect('brand' in out.card).toBe(false);
    expect(out.phones).toEqual(['13900005678']);
    expect(out['weird.key']).toBe('***');
    expect(out.keep).toBe('visible');
    // Original is untouched.
    expect(tree.card.number).toBe('4111111111111111');
  });

  it('drops multiple array indices without index shifting', () => {
    const tree = {items: [{v: 'a'}, {v: 'b'}, {v: 'c'}]};
    const out = redactTree(tree, [
      r({scope: 'body', target: 'items[0]', action: 'drop'}),
      r({scope: 'body', target: 'items[1]', action: 'drop'}),
    ]);
    expect(out.items).toEqual([{v: 'c'}]);
  });

  it('does not crash when targets are missing or of the wrong container type', () => {
    const tree = {a: 1, b: [1, 2]};
    expect(() => redactTree(tree, [
      r({scope: 'body', target: 'a.x', action: 'drop'}),
      r({scope: 'body', target: 'b[5]', action: 'replace', replacement: 'z'}),
      r({scope: 'body', target: 'missing.deep', action: 'tail', keepLast: 1}),
    ])).not.toThrow();
  });

  it('redacts headers case-insensitively', () => {
    const out = redactHeaders(
      {'Authorization': 'Bearer abcdef123456', 'X-Trace': 't-1'},
      [r({scope: 'header', target: 'authorization', action: 'tail', keepLast: 4})],
    );
    expect(out.Authorization).toBe('3456');
    expect(out['X-Trace']).toBe('t-1');
  });

  it('re-applies current rules to a stored snapshot for replays', () => {
    const tree = {token: 'abcdefghij', note: 'keep-me'};
    const stored = redactTree(tree, [r({scope: 'body', target: 'token', action: 'tail', keepLast: 6})]);
    expect(stored.token).toBe('efghij');
    // After editing the rules, a replay follows the new rule set.
    const next = redactStored({}, 'json', stored, JSON.stringify(stored), [
      r({scope: 'body', target: 'token', action: 'replace', replacement: 'X'}),
      r({scope: 'body', target: 'note', action: 'drop'}),
    ]);
    expect((next.tree as {token: string; note?: string}).token).toBe('X');
    expect('note' in (next.tree as object)).toBe(false);
    expect(JSON.parse(next.text)).toEqual({token: 'X'});
  });

  it('parses form bodies into a tree', () => {
    const parsed = parseBody(Buffer.from('a=1&b=two&b=three'), 'application/x-www-form-urlencoded');
    expect(parsed.kind).toBe('form');
    expect(parsed.tree).toEqual({a: '1', b: ['two', 'three']});
  });
});
