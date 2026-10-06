import {describe, expect, it} from 'vitest';
import {applyAtPath, DELETE_TOKEN, parsePath, resolvePath} from '../src/server/jsonpath.js';

describe('parsePath', () => {
  it('解析点号、括号键名与数组下标', () => {
    expect(parsePath('$.a.b')).toEqual([{ type: 'key', value: 'a' }, { type: 'key', value: 'b' }]);
    expect(parsePath('$["a.b"]')).toEqual([{ type: 'key', value: 'a.b' }]);
    expect(parsePath('$["a.b"][0]')).toEqual([{ type: 'key', value: 'a.b' }, { type: 'index', value: 0 }]);
    expect(parsePath('$[12]')).toEqual([{ type: 'index', value: 12 }]);
    expect(parsePath(" $['x'] ")).toEqual([{ type: 'key', value: 'x' }]);
  });

  it.each([
    ['', 1],
    ['a.b', 1],
    ['$.', 2],
    ['$..a', 3],
    ['$.*', 3],
    ['$.[a]', 3],
    ['$[a]', 3],
    ['$[01]', 3],
    ['$[-3]', 3],
    ['$["a', 5], // 缺右括号，指向字符串末尾
    ['$.a-b', 4], // 非法字符位置
    ['$.1abc', 3],
    ['$["\\q"]', 5],
  ])('非法路径 %j 报字符位置 %s', (input, column) => {
    try {
      parsePath(input);
      throw new Error('应当抛错');
    } catch (e: any) {
      expect(e.column).toBe(column);
      expect(e.code).toBe('JSONPATH_PARSE_ERROR');
      expect(e.message).toContain('第');
    }
  });

  it('报错位置基于用户原始输入（含前导空格）', () => {
    try {
      parsePath('   $.a-b');
      throw new Error('应当抛错');
    } catch (e: any) {
      expect(e.column).toBe(7); // 3 空格 + $ . a，'-' 在第 7 个字符
    }
  });
});

describe('resolvePath / applyAtPath', () => {
  const root = { a: { 'a.b': [{ card: '6222' }, { card: '9999' }], phone: '138' }, arr: [1, 2, 3] };

  it('沿路径取值', () => {
    expect(resolvePath(root, parsePath('$.a.phone'))).toBe('138');
    expect(resolvePath(root, parsePath('$.a["a.b"][1].card'))).toBe('9999');
    expect(resolvePath(root, parsePath('$.arr[0]'))).toBe(1);
    expect(resolvePath(root, parsePath('$.missing.x'))).toBeUndefined();
  });

  it('替换值且不改原对象', () => {
    const next = applyAtPath(root, parsePath('$.a.phone'), '***') as any;
    expect(next.a.phone).toBe('***');
    expect(root.a.phone).toBe('138');
  });

  it('删除键与数组元素', () => {
    const next = applyAtPath(root, parsePath('$.a.phone'), DELETE_TOKEN) as any;
    expect('phone' in next.a).toBe(false);
    const next2 = applyAtPath(root, parsePath('$.arr[1]'), DELETE_TOKEN) as any;
    expect(next2.arr).toEqual([1, 3]);
  });

  it('中间缺失时补建容器', () => {
    const next = applyAtPath({}, parsePath('$.x[0].y'), 'v') as any;
    expect(next.x[0].y).toBe('v');
    const next2 = applyAtPath(null, parsePath('$.a["b.c"]'), 'v') as any;
    expect(next2.a['b.c']).toBe('v');
  });
});
