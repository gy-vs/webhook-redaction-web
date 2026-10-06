import {describe, expect, it} from 'vitest';
import {parseBody} from '../src/server/bodyParser.js';
import {applyRules, validateRule, validateRules} from '../src/server/redaction.js';
import type {RedactionRule} from '../src/shared/types.js';

function run(raw: string, contentType: string | null, headers: Record<string, string>, rules: RedactionRule[]) {
  const parsed = parseBody(Buffer.from(raw, 'utf8'), contentType);
  return applyRules(parsed, headers, rules);
}

describe('脱敏动作', () => {
  const rules: RedactionRule[] = [
    { id: 'r1', name: '卡号', enabled: true, target: { kind: 'jsonPath', path: '$.pay.card' }, action: { type: 'last', keep: 4, mask: '*' } },
    { id: 'r2', name: 'token', enabled: true, target: { kind: 'jsonPath', path: '$.token' }, action: { type: 'remove' } },
    { id: 'r3', name: '手机号', enabled: true, target: { kind: 'jsonPath', path: '$.phones[1]' }, action: { type: 'replace', text: '[REDACTED]' } },
    { id: 'r4', name: '点号键', enabled: true, target: { kind: 'jsonPath', path: '$["a.b"]' }, action: { type: 'replace', text: 'X' } },
    { id: 'r5', name: '授权头', enabled: true, target: { kind: 'header', name: 'authorization' }, action: { type: 'last', keep: 6, mask: 'Bearer ' } },
  ];

  it('三种动作、数组下标、带点键、头规则同时生效', () => {
    const raw = JSON.stringify({
      pay: { card: '6222021234567890123' },
      token: 'eyJ.secret.value',
      phones: ['13800000000', '13911112222'],
      'a.b': 'dotkey',
    });
    const out = run(raw, 'application/json', { Authorization: 'Bearer abcdefXYZ123', 'X-Keep': 'visible' }, rules);
    expect(out.body.body).toEqual({
      pay: { card: '*0123' },
      phones: ['13800000000', '[REDACTED]'],
      'a.b': 'X',
    });
    expect(out.body.body).not.toHaveProperty('token');
    expect(out.headers['Authorization']).toBe('Bearer XYZ123'); // Bearer + 末尾 6 位
    expect(out.headers['X-Keep']).toBe('visible');
  });

  it('处理结果里完全找不到原值，序列化后也没有', () => {
    const secret = 'SENSITIVE-RAW-42';
    const raw = JSON.stringify({ nested: { token: secret }, phone: '13812345678' });
    const rs: RedactionRule[] = [
      { id: 'a', name: 't', enabled: true, target: { kind: 'jsonPath', path: '$.nested.token' }, action: { type: 'remove' } },
      { id: 'b', name: 'p', enabled: true, target: { kind: 'jsonPath', path: '$.phone' }, action: { type: 'last', keep: 4, mask: '*' } },
      { id: 'c', name: 'h', enabled: true, target: { kind: 'header', name: 'x-token' }, action: { type: 'remove' } },
    ];
    const out = run(raw, 'application/json', { 'x-token': secret }, rs);
    const dumped = JSON.stringify(out) + JSON.stringify(out.body);
    expect(dumped).not.toContain(secret);
    expect(dumped).toContain('*5678');
  });

  it('表单正文里的字段也按 JSON 路径处理', () => {
    const out = run('card=6222021234567890123&name=ok', 'application/x-www-form-urlencoded', {}, [
      { id: 'a', name: 'card', enabled: true, target: { kind: 'jsonPath', path: '$.card' }, action: { type: 'last', keep: 4, mask: '' } },
    ]);
    expect(out.body.bodyKind).toBe('form');
    expect(out.body.body).toEqual({ card: '0123', name: 'ok' });
  });

  it('停用的规则不生效；路径未命中不报错', () => {
    const out = run(JSON.stringify({ a: 1 }), 'application/json', {}, [
      { id: 'a', name: 'x', enabled: false, target: { kind: 'jsonPath', path: '$.a' }, action: { type: 'remove' } },
      { id: 'b', name: 'y', enabled: true, target: { kind: 'jsonPath', path: '$.missing' }, action: { type: 'remove' } },
    ]);
    expect(out.body.body).toEqual({ a: 1 });
    expect(out.touched).toBe(0);
  });
});

describe('规则校验', () => {
  it('路径写错时指出第几个字符', () => {
    const rule: RedactionRule = {
      id: 'a', name: 'bad', enabled: true,
      target: { kind: 'jsonPath', path: '$.user.' },
      action: { type: 'remove' },
    };
    const err = validateRule(rule)!;
    expect(err.column).toBe(7);
  });

  it('动作参数校验', () => {
    expect(validateRules([
      { id: 'a', name: '', enabled: true, target: { kind: 'jsonPath', path: '$' }, action: { type: 'remove' } },
    ])[0].message).toContain('名称');
    expect(validateRules([
      { id: 'b', name: 'n', enabled: true, target: { kind: 'jsonPath', path: '$' }, action: { type: 'last', keep: 0, mask: '*' } },
    ])[0].message).toContain('保留位数');
    expect(validateRules([
      { id: 'c', name: 'n', enabled: true, target: { kind: 'jsonPath', path: '$' }, action: { type: 'replace', text: '' } },
    ])[0].message).toContain('替换文本');
  });
});
