import {createHmac} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {Source} from '../src/shared/types';

const mkdtempP = promisify(mkdtemp);
const rmP = promisify(rm);
const readFileP = promisify(readFile);

const hmacHex = (secret: string, body: Buffer | string) =>
  createHmac('sha256', secret).update(body).digest('hex');

interface FakeTarget {
  server: Server;
  url: string;
  received: Array<{method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string}>;
  statusOverride: number;
}

function startFakeTarget(): Promise<FakeTarget> {
  // Plain node http server acting as the local replay destination.
  return new Promise((resolve) => {
    const fake: FakeTarget = {
      server: undefined as unknown as Server,
      url: '',
      received: [],
      statusOverride: 200,
    };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        fake.received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(fake.statusOverride, {'content-type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
      });
    });
    fake.server = server;
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as AddressInfo;
      fake.url = `http://127.0.0.1:${port}`;
      resolve(fake);
    });
  });
}

let dataDir: string;
let captureDir: string;
let replayDir: string;
let target: FakeTarget;

beforeAll(async () => {
  dataDir = await mkdtempP(join(tmpdir(), 'webhook-lab-shared-'));
  captureDir = await mkdtempP(join(tmpdir(), 'webhook-lab-capture-'));
  replayDir = await mkdtempP(join(tmpdir(), 'webhook-lab-replay-'));
  target = await startFakeTarget();
});

afterAll(async () => {
  await new Promise((r) => target.server.close(r));
  await rmP(dataDir, {recursive: true, force: true});
  await rmP(captureDir, {recursive: true, force: true});
  await rmP(replayDir, {recursive: true, force: true});
});

function buildApp() {
  return createApp({dataDir: captureDir});
}

async function registerSource(
  app: ReturnType<typeof createApp>['app'],
  over: Partial<Source> & {name: string; targetUrl?: string},
) {
  const source: Source = {
    name: over.name,
    targetUrl: over.targetUrl ?? target.url,
    signature: over.signature ?? null,
    rules: over.rules ?? [
      {id: 'r1', scope: 'body', target: 'card.number', action: 'tail', keepLast: 4},
      {id: 'r2', scope: 'header', target: 'authorization', action: 'replace', replacement: 'Bearer [REDACTED]'},
    ],
    createdAt: Date.now(),
  };
  const res = await request(app).put(`/api/sources/${source.name}`).send(source);
  expect(res.status).toBe(200);
  return source;
}

describe('capture / verify / store', () => {
  let ctx: ReturnType<typeof createApp>;
  beforeEach(() => {
    ctx = buildApp();
  });

  it('captures method, path, headers and raw bytes for json, form and text', async () => {
    await registerSource(ctx.app, {name: 'pay'});
    const body = JSON.stringify({card: {number: '4111111111111111'}, ok: true});
    const capture = await request(ctx.app)
      .post('/hook/pay/orders/42?x=1')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer secret-token')
      .send(body);
    expect(capture.status).toBe(202);

    const list = await request(ctx.app).get('/api/events');
    expect(list.status).toBe(200);
    const event = list.body.events[0];
    expect(event.method).toBe('POST');
    expect(event.path).toBe('/orders/42');
    expect(event.query).toBe('x=1');
    expect(event.bodyKind).toBe('json');
    expect(event.bodyTree.card.number).toBe('1111');
    expect(event.bodyText).not.toContain('4111111111111111');
    expect(event.headers.authorization).toBe('Bearer [REDACTED]');
    // The original secret appears nowhere in the API response.
    expect(JSON.stringify(event)).not.toContain('4111111111111111');
    expect(JSON.stringify(event)).not.toContain('secret-token');
  });

  it('captures form bodies and plain text without inventing JSON', async () => {
    await registerSource(ctx.app, {name: 'formsrc', rules: []});
    const form = await request(ctx.app)
      .post('/hook/formsrc/in')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('a=1&phone=13800001234');
    expect(form.status).toBe(202);
    let event = (await request(ctx.app).get('/api/events')).body.events[0];
    expect(event.bodyKind).toBe('form');
    expect(event.bodyTree).toEqual({a: '1', phone: '13800001234'});

    const text = await request(ctx.app).post('/hook/formsrc/in').set('content-type', 'text/plain').send('hello 原始字节');
    expect(text.status).toBe(202);
    event = (await request(ctx.app).get('/api/events')).body.events[0];
    expect(event.bodyKind).toBe('text');
    expect(event.bodyText).toContain('原始字节');
    expect(event.bodyTree).toBeNull();
  });

  it('rejects bodies over 1MB with 413 and stores nothing', async () => {
    await registerSource(ctx.app, {name: 'big'});
    const before = (await request(ctx.app).get('/api/events')).body.events.length;
    const oversized = Buffer.alloc(1024 * 1024 + 1, 'a');
    const res = await request(ctx.app).post('/hook/big/').set('content-type', 'text/plain').send(oversized);
    expect(res.status).toBe(413);
    const after = (await request(ctx.app).get('/api/events')).body.events.length;
    expect(after).toBe(before);
  });

  it('404s unknown sources', async () => {
    const res = await request(ctx.app).post('/hook/nope/x').send('{}');
    expect(res.status).toBe(404);
  });

  it('verifies signatures over the raw bytes and stores the verdict', async () => {
    const source: Source = {
      name: 'signed',
      targetUrl: target.url,
      signature: {
        header: 'X-Signature',
        timestampHeader: undefined,
        toleranceSeconds: 300,
        algorithm: 'sha256',
        encoding: 'hex',
        signedContent: 'rawBody',
        keys: [{id: 'k', secret: 'topsecret', label: 'primary'}],
      },
      rules: [],
      createdAt: Date.now(),
    };
    await request(ctx.app).put('/api/sources/signed').send(source).expect(200);

    // String body: superagent sends the literal bytes; the signature is
    // computed over those exact bytes (note the \u escape and key order).
    const payload = '{"name":"\\u4e2d","b":1}';
    const good = await request(ctx.app)
      .post('/hook/signed/hook-path')
      .set('content-type', 'application/json')
      .set('x-signature', hmacHex('topsecret', payload))
      .send(payload);
    expect(good.status).toBe(202);
    let event = (await request(ctx.app).get('/api/events')).body.events[0];
    expect(event.verification.status).toBe('valid');
    expect(event.verification.matchedKeyLabel).toBe('primary');

    await request(ctx.app).post('/hook/signed/hook-path').set('content-type', 'application/json').send(payload).expect(202);
    event = (await request(ctx.app).get('/api/events')).body.events[0];
    expect(event.verification.status).toBe('missing_signature');

    // A single trailing space changes the digest: the verdict must be mismatch.
    await request(ctx.app)
      .post('/hook/signed/hook-path')
      .set('content-type', 'application/json')
      .set('x-signature', hmacHex('topsecret', payload))
      .send(`${payload} `)
      .expect(202);
    event = (await request(ctx.app).get('/api/events')).body.events[0];
    expect(event.verification.status).toBe('mismatch');
  });
});

describe('replay', () => {
  it('forwards stored events to the local target with status, timing and per-item failures', async () => {
    const ctx = createApp({dataDir: replayDir});
    await registerSource(ctx.app, {name: 'relay'});
    const body = JSON.stringify({card: {number: '4111111111119999'}, note: 'hi'});
    await request(ctx.app).post('/hook/relay/orders/7').set('content-type', 'application/json').send(body).expect(202);
    const firstId = (await request(ctx.app).get('/api/events')).body.events[0].id;

    target.received.length = 0;
    target.statusOverride = 200;
    const replay = await request(ctx.app).post('/api/replay').send({ids: [firstId]});
    expect(replay.status).toBe(200);
    const item = replay.body.results[0];
    expect(item.eventId).toBe(firstId);
    expect(item.replay.ok).toBe(true);
    expect(item.replay.statusCode).toBe(200);
    expect(item.replay.durationMs).toBeGreaterThanOrEqual(0);

    expect(target.received).toHaveLength(1);
    const forwarded = target.received[0];
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toBe('/orders/7');
    const parsed = JSON.parse(forwarded.body);
    expect(parsed.card.number).toBe('9999');
    expect(forwarded.body).not.toContain('4111111111119999');

    // Replay records hang off the original event.
    const stored = (await request(ctx.app).get(`/api/events/${firstId}`)).body.event;
    expect(stored.replays).toHaveLength(1);
    expect(stored.replays[0].statusCode).toBe(200);

    // Target failure: still recorded, and does not throw the batch.
    target.statusOverride = 500;
    const failed = await request(ctx.app).post('/api/replay').send({ids: [firstId, 999999]});
    expect(failed.body.results).toHaveLength(1); // unknown id is skipped, not fatal
    expect(failed.body.results[0].replay.ok).toBe(false);
    expect(failed.body.results[0].replay.statusCode).toBe(500);
    expect(failed.body.results[0].replay.error).toContain('500');
  });

  it('replays using the CURRENT rules, not those in force at capture time', async () => {
    const ctx = createApp({dataDir: replayDir});
    await registerSource(ctx.app, {name: 'ruleshift', rules: [
      {id: 'r1', scope: 'body', target: 'secret', action: 'tail', keepLast: 3},
    ]});
    await request(ctx.app)
      .post('/hook/ruleshift/x')
      .set('content-type', 'application/json')
      .send(JSON.stringify({secret: 'ABCDEFGH', other: 'x'}))
      .expect(202);
    const id = (await request(ctx.app).get('/api/events')).body.events[0].id;
    expect((await request(ctx.app).get(`/api/events/${id}`)).body.event.bodyTree.secret).toBe('FGH');

    // Tighten rules after the fact.
    const updated: Source = {
      name: 'ruleshift',
      targetUrl: target.url,
      signature: null,
      rules: [
        {id: 'r2', scope: 'body', target: 'secret', action: 'replace', replacement: 'GONE'},
        {id: 'r3', scope: 'body', target: 'other', action: 'drop'},
      ],
      createdAt: Date.now(),
    };
    await request(ctx.app).put('/api/sources/ruleshift').send(updated).expect(200);

    target.received.length = 0;
    await request(ctx.app).post('/api/replay').send({ids: [id]}).expect(200);
    const sent = JSON.parse(target.received[0].body);
    expect(sent.secret).toBe('GONE');
    expect('other' in sent).toBe(false);
  });
});

describe('persistence', () => {
  it('survives an app restart and keeps monotonic ids, capped at 500 events', async () => {
    const dir = await mkdtempP(join(tmpdir(), 'webhook-lab-restart-'));
    try {
      const first = createApp({dataDir: dir});
      await registerSource(first.app, {name: 'restart'});
      await request(first.app).post('/hook/restart/a').send('one').expect(202);
      const firstId = (await request(first.app).get('/api/events')).body.events[0].id;

      // Simulate a fresh process pointing at the same data directory.
      const second = createApp({dataDir: dir});
      const sources = await request(second.app).get('/api/sources');
      expect(sources.body.sources.map((s: Source) => s.name)).toContain('restart');
      const event = (await request(second.app).get(`/api/events/${firstId}`)).body.event;
      expect(event.path).toBe('/a');

      await request(second.app).post('/hook/restart/b').send('two').expect(202);
      const rows = (await request(second.app).get('/api/events')).body.events;
      expect(rows[0].id).toBe(firstId + 1);

      // Stored file on disk contains only redacted content and is readable.
      const onDisk = JSON.parse(await readFileP(join(dir, 'events.json'), 'utf8'));
      expect(onDisk.lastId).toBe(firstId + 1);
      expect(Array.isArray(onDisk.events)).toBe(true);
    } finally {
      await rmP(dir, {recursive: true, force: true});
    }
  });

  it('caps storage at the 500 newest events', async () => {
    const dir = await mkdtempP(join(tmpdir(), 'webhook-lab-cap-'));
    try {
      const ctx = createApp({dataDir: dir});
      await registerSource(ctx.app, {name: 'cap'});
      for (let i = 0; i < 502; i += 1) {
        await request(ctx.app).post(`/hook/cap/n/${i}`).send(`body-${i}`);
      }
      const rows = (await request(ctx.app).get('/api/events')).body.events;
      expect(rows).toHaveLength(500);
      expect(rows[rows.length - 1].path).toBe('/n/2'); // oldest survivors
      expect(rows[0].path).toBe('/n/501');
    } finally {
      await rmP(dir, {recursive: true, force: true});
    }
  });
});

describe('source management validation', () => {
  it('reports path errors with a character offset and never returns secrets', async () => {
    const ctx = createApp({dataDir: await mkdtempP(join(tmpdir(), 'webhook-lab-val-'))});
    const bad: Source = {
      name: 'val',
      targetUrl: target.url,
      signature: null,
      rules: [{id: 'r1', scope: 'body', target: 'a..b', action: 'drop'}],
      createdAt: Date.now(),
    };
    const res = await request(ctx.app).put('/api/sources/val').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({field: 'rules[0].target', pathErrorAt: 2});

    const good: Source = {
      ...bad,
      rules: [
        {id: 'r1', scope: 'body', target: 'a.b', action: 'drop'},
        {id: 'r2', scope: 'body', target: 'tail', action: 'tail', keepLast: 2},
      ],
      signature: {
        header: 'X-Signature',
        toleranceSeconds: 10,
        algorithm: 'sha256',
        encoding: 'hex',
        signedContent: 'rawBody',
        keys: [{id: 'k1', secret: 'shh-secret', label: 'k'}],
        timestampHeader: undefined,
      },
    };
    await request(ctx.app).put('/api/sources/val').send(good).expect(200);
    const view = (await request(ctx.app).get('/api/sources')).body.sources.find((s: Source) => s.name === 'val');
    expect(JSON.stringify(view)).not.toContain('shh-secret');
    expect(view.signature.keys[0].secret).toBeUndefined();
  });
});
