import {describe, expect, it} from 'vitest';
import {getAt, locate, parsePath, PathParseError} from '../src/shared/jsonpath';

describe('parsePath', () => {
  it('parses bare names, dots and indices', () => {
    expect(parsePath('a.b.c')).toEqual([{kind: 'key', key: 'a'}, {kind: 'key', key: 'b'}, {kind: 'key', key: 'c'}]);
    expect(parsePath('items[0]')).toEqual([{kind: 'key', key: 'items'}, {kind: 'index', index: 0}]);
    expect(parsePath('[0][12]')).toEqual([{kind: 'index', index: 0}, {kind: 'index', index: 12}]);
  });

  it('parses quoted keys with dots and escapes', () => {
    expect(parsePath('a["weird.key"].b')).toEqual([
      {kind: 'key', key: 'a'}, {kind: 'key', key: 'weird.key'}, {kind: 'key', key: 'b'},
    ]);
    expect(parsePath("x['it\\'s']")[1]).toEqual({kind: 'key', key: "it's"});
    expect(parsePath('u["\\u4e2d"]')[1]).toEqual({kind: 'key', key: '中'});
  });

  it('reports exact character offsets', () => {
    const cases: Array<[string, number]> = [
      ['', 0],
      ['.a', 0],
      ['a.', 1],
      ['a..b', 2],
      ['a.b[', 3],
      ['a[b]', 2],
      ['a[01]', 3],
      ['a["x', 2],
      ['1abc', 0],
      ['a.[0]', 2],
    ];
    for (const [input, offset] of cases) {
      try {
        parsePath(input);
        throw new Error(`expected error for ${JSON.stringify(input)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PathParseError);
        expect((err as PathParseError).offset, JSON.stringify(input)).toBe(offset);
      }
    }
  });

  it('locate and getAt walk real data', () => {
    const root = {items: [{card: {number: '4111'}}], 'a.b': [10]};
    expect(getAt(root, parsePath('items[0].card.number'))).toBe('4111');
    expect(getAt(root, parsePath('["a.b"][0]'))).toBe(10);
    expect(getAt(root, parsePath('items[9].x'))).toBeUndefined();
    const match = locate(root, parsePath('items[0].card.number'));
    expect(match?.parent).toBe(root.items[0].card);
    expect(match?.key).toBe('number');
  });
});
