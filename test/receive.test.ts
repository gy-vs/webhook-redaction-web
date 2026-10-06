import {describe, expect, it} from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import request from 'supertest';
import {createApp, Store} from '../src/server/index.js';
import type {RedactionRule, SecretDef, SignerInput, SourceView} from '../src/shared/types.js';

const hmac = (alg: string, secret: string, buf: Buffer, enc: 'hex' | 'base64' = 'hex') =>
  crypto.createHmac(alg, secret).update(buf).digest(enc);

/** supertest 的 .send(Buffer) 在 content-type: application/json 时会序列化成 {"type":"Buffer"}，发原始字节必须用 write。 */
function postRaw(app: express.Express, url: string, raw: Buffer, headers: Record<string, string> = {}) {
  const req = request(app).post(url);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  (req as unknown as { write: (b: Buffer) => void }).write(raw);
  return req;
}

async function tempStore(): Promise<{ store: Store; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'whlab-'));
  const store = new Store(path.join(dir, 'db.json'));
  await store.load();
  return { store, dir };
}

async function registerSource(app: ReturnType<typeof createApp>, name: string, signer?: Partial<SignerInput> & { secrets: SecretDef[] }) {
  const body = signer
    ? {
        replayTarget: null,
        signer: {
          header: signer.header ?? 'x-signature',
          algorithm: signer.algorithm ?? 'sha256',
          encoding: signer.encoding ?? 'hex',
          secrets: signer.secrets,
          timestampHeader: signer.timestampHeader ?? null,
          timestampSkewSeconds: signer.timestampSkewSeconds ?? 300,
        },
      }
    : { replayTarget: null, signer: null };
  const res = await request(app).put(`/api/sources/${name}`).send(body);
  expect(res.status).toBe(200);
  return res.body as SourceView;
}

describe('接收：方法/路径/头/正文原样记录', () => {
  it('记录 POST JSON 的全部信息并给出 not-configured 结论', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'pay');
    const res = await request(app)
      .post('/hook/pay/orders/123?x=1')
      .set('X-Custom', 'hello-123')
      .send({a: 1});
    expect(res.status).toBe(202);
    const list = await request(app).get('/api/events');
    const e = list.body[0];
    expect(e.method).toBe('POST');
    expect(e.path).toBe('/hook/pay/orders/123?x=1');
    expect(Object.entries(e.headers).find(([k]) => k.toLowerCase() === 'x-custom')?.[1]).toBe('hello-123');
    expect(e.bodyKind).toBe('json');
    expect(e.body).toEqual({a: 1});
    expect(e.verification.status).toBe('not-configured');
  });

  it('表单与纯文本正文都能记录', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'logi');
    await request(app).post('/hook/logi/f').type('form').send({phone: '13800000000'});
    await request(app).post('/hook/logi/t').set('content-type', 'text/plain').send('hello world');
    const events = (await request(app).get('/api/events')).body;
    expect(events[0].bodyKind).toBe('text');
    expect(events[0].rawText).toBe('hello world');
    expect(events[1].bodyKind).toBe('form');
    expect(events[1].body.phone).toBe('13800000000');
  });

  it('超过 1MB 返回 413 且不留任何记录', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'big');
    const oversized = Buffer.alloc(1024 * 1024 + 1, 'a');
    const res = await request(app).post('/hook/big').set('content-type', 'text/plain').send(oversized);
    expect(res.status).toBe(413);
    const events = (await request(app).get('/api/events')).body;
    expect(events).toHaveLength(0);
  });

  it('恰好 1MB 通过', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'edge');
    const exact = Buffer.alloc(1024 * 1024, 'a');
    const res = await request(app).post('/hook/edge').set('content-type', 'text/plain').send(exact);
    expect(res.status).toBe(202);
  });

  it('未登记来源返回 404', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    const res = await request(app).post('/hook/nope').send({});
    expect(res.status).toBe(404);
  });
});

describe('验签：对原始字节', () => {
  it('字节一致就通过：中文 \\u 转义、键顺序、多余空格都不影响（只要字节没改）', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'pay', { secrets: [{ id: 's1', label: 'k', secret: 'shh' }] });

    // 1) 中文被写成 \u 转义：签名算的是发出去的那串字节
    const escaped = '{"name":"\\u5f20\\u4e09"}';
    const sig1 = hmac('sha256', 'shh', Buffer.from(escaped));
    const r1 = await postRaw(app, '/hook/pay', Buffer.from(escaped), {
      'content-type': 'application/json', 'x-signature': sig1,
    });
    expect(r1.body.id).toBeTypeOf('number');
    const e1 = (await request(app).get(`/api/events?after=${r1.body.id - 1}`)).body[0];
    expect(e1.verification.status).toBe('valid');
    // 服务端保存的 JSON 解析结果里中文正常，验签却仍是按原始字节过的
    expect(e1.body.name).toBe('张三');

    // 2) 多一个空格但签名同步重算（模拟对方就发的这个字节串）
    const spaced = '{"a": 1, "b": 2}';
    const sig2 = hmac('sha256', 'shh', Buffer.from(spaced));
    const r2 = await postRaw(app, '/hook/pay', Buffer.from(spaced), {
      'content-type': 'application/json', 'x-signature': sig2,
    });
    const e2 = (await request(app).get(`/api/events?after=${r2.body.id - 1}`)).body[0];
    expect(e2.verification.status).toBe('valid');
  });

  it('字节被改（哪怕只是末尾多个点）签名对不上', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'pay', { secrets: [{ id: 's1', label: 'k', secret: 'shh' }] });
    const body = Buffer.from('{"a":1}');
    const res = await postRaw(app, '/hook/pay', body, {
      'content-type': 'application/json',
      'x-signature': hmac('sha256', 'shh', Buffer.concat([body, Buffer.from('.')])),
    });
    const e = (await request(app).get(`/api/events?after=${res.body.id - 1}`)).body[0];
    expect(e.verification.status).toBe('mismatch');
  });

  it('区分 unsigned / malformed / timestamp 各类失败结论', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'ts', {
      secrets: [{ id: 's1', label: 'k', secret: 'shh' }],
      timestampHeader: 'x-ts',
      timestampSkewSeconds: 60,
    });
    const body = Buffer.from('{}');
    const nowTs = String(Math.floor(Date.now() / 1000));

    // 没带签名头
    const r1 = await postRaw(app, '/hook/ts', body, { 'content-type': 'application/json' });
    expect((await latest(app, r1.body.id)).verification.status).toBe('unsigned-request');

    // 时间戳超窗
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const r2 = await postRaw(app, '/hook/ts', body, {
      'content-type': 'application/json',
      'x-signature': hmac('sha256', 'shh', body),
      'x-ts': String(oldTs),
    });
    expect((await latest(app, r2.body.id)).verification.status).toBe('timestamp-out-of-range');

    // 签名格式不对
    const r3 = await postRaw(app, '/hook/ts', body, {
      'content-type': 'application/json',
      'x-signature': 'not hex!!',
      'x-ts': nowTs,
    });
    expect((await latest(app, r3.body.id)).verification.status).toBe('malformed-signature');

    // 全齐但值不对
    const r4 = await postRaw(app, '/hook/ts', body, {
      'content-type': 'application/json',
      'x-signature': hmac('sha256', 'shh', Buffer.from('other')),
      'x-ts': nowTs,
    });
    expect((await latest(app, r4.body.id)).verification.status).toBe('mismatch');
  });

  it('换密钥期间新旧两把都认', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    const secrets: SecretDef[] = [
      { id: 'old', label: 'old', secret: 'OLD' },
      { id: 'new', label: 'new', secret: 'NEW' },
    ];
    await registerSource(app, 'rot', { secrets });
    const body = Buffer.from('{"v":1}');
    for (const [secret, label] of [['OLD', 'old'], ['NEW', 'new']] as const) {
      const r = await postRaw(app, '/hook/rot', body, {
        'content-type': 'application/json', 'x-signature': hmac('sha256', secret, body),
      });
      const v = (await latest(app, r.body.id)).verification;
      expect(v.status).toBe('valid');
      expect(v.matchedSecretLabel).toBe(label);
    }
  });

  it('base64 签名与 sha256= 前缀也能验', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'b64', {
      secrets: [{ id: 's', label: 'k', secret: 'k' }],
      encoding: 'base64',
    });
    const body = Buffer.from('abc');
    const digest = 'sha256=' + hmac('sha256', 'k', body, 'base64');
    const r = await request(app).post('/hook/b64').set('content-type', 'text/plain')
      .set('x-signature', digest).send(body);
    expect((await latest(app, r.body.id)).verification.status).toBe('valid');
  });

  it('密钥不会通过任何接口回显', async () => {
    const {store} = await tempStore();
    const app = createApp(store);
    await registerSource(app, 'sec', { secrets: [{ id: 's', label: 'k', secret: 'TOPSECRET' }] });
    const list = await request(app).get('/api/sources');
    expect(JSON.stringify(list.body)).not.toContain('TOPSECRET');
    // 编辑时留空密钥也不报错（沿用已存密钥）
    const edit = await request(app).put('/api/sources/sec').send({
      replayTarget: null,
      signer: {
        header: 'x-signature', algorithm: 'sha256', encoding: 'hex',
        timestampHeader: null, timestampSkewSeconds: 300,
        secrets: [{ id: 's', label: 'k-renamed', secret: '' }],
      },
    });
    expect(edit.status).toBe(200);
    expect(JSON.stringify(edit.body)).not.toContain('TOPSECRET');
    const body = Buffer.from('z');
    const r = await postRaw(app, '/hook/sec', body, { 'x-signature': hmac('sha256', 'TOPSECRET', body) });
    expect((await latest(app, r.body.id)).verification.status).toBe('valid');
  });
});

async function latest(app: express.Express, id: number) {
  const res = await request(app).get(`/api/events?after=${id - 1}`);
  return res.body[0];
}
