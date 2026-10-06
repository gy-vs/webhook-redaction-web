import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import request from 'supertest';
import {createApp, Store} from '../src/server/index.js';
import type {RedactionRule} from '../src/shared/types.js';

interface FakeTarget {
  url: string;
  received: { url: string; body: string; headers: http.IncomingHttpHeaders; method: string | undefined }[];
  setBehavior: (b: (req: http.IncomingMessage, body: string) => number) => void;
  close: () => Promise<void>;
}

/** 测试里临时起的假本地目标：记录收到的字节，可控制返回码。 */
function startFakeTarget(): Promise<FakeTarget> {
  const received: FakeTarget['received'] = [];
  let behavior: (req: http.IncomingMessage, body: string) => number = () => 200;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ url: req.url ?? '', body, headers: req.headers, method: req.method });
      const code = behavior(req, body);
      res.statusCode = code;
      res.end(code === 200 ? 'ok' : `fail-${code}`);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        setBehavior: b => { behavior = b; },
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

const dirs: string[] = []
async function freshStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'whlab-r-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'db.json'));
  await store.load();
  return store;
}

const phoneRules: RedactionRule[] = [
  { id: 'p', name: '手机号', enabled: true, target: { kind: 'jsonPath', path: '$.phone' }, action: { type: 'last', keep: 4, mask: '*' } },
];

describe('重放', () => {
  let target: FakeTarget;
  beforeAll(async () => { target = await startFakeTarget(); });
  afterAll(async () => { await target.close(); });

  it('重放把方法/子路径/正文发到目标，状态码耗时挂回事件', async () => {
    const store = await freshStore();
    const app = createApp(store);
    await request(app).put('/api/sources/pay').send({ replayTarget: target.url, signer: null });
    const cap = await request(app).post('/hook/pay/sub/9?z=1').send({ hello: 'world' });
    const id = cap.body.id;

    const res = await request(app).post('/api/replay').send({ ids: [id] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[0].status).toBe(200);
    expect(res.body.results[0].durationMs).toBeGreaterThanOrEqual(0);

    expect(target.received).toHaveLength(1);
    expect(target.received[0].method).toBe('POST');
    expect(target.received[0].url).toBe('/sub/9?z=1');
    expect(target.received[0].body).toBe(JSON.stringify({ hello: 'world' }));

    const events = (await request(app).get('/api/events')).body;
    const rec = events[0].replays[0];
    expect(rec.status).toBe(200);
    expect(rec.ok).toBe(true);
    expect(rec.target).toContain('/sub/9?z=1');
    expect(typeof rec.durationMs).toBe('number');
  });

  it('规则改了以后重放旧事件，发出去的是按新规则处理过的内容', async () => {
    const store = await freshStore();
    const app = createApp(store);
    await request(app).put('/api/sources/pay').send({ replayTarget: target.url, signer: null });
    // 先在「没有规则」的时候收一条带手机号的事件
    const before = target.received.length;
    const cap = await request(app).post('/hook/pay/order').send({ phone: '13912345678', name: '张三' });
    const id = cap.body.id;
    // 再加规则
    await request(app).put('/api/rules').send({ rules: phoneRules });
    // 重放
    await request(app).post('/api/replay').send({ ids: [id] });

    const sent = target.received[target.received.length - 1];
    expect(sent.body).not.toContain('13912345678');
    expect(sent.body).toContain('*5678');
    expect(sent.body).toContain('张三');
    void before;
  });

  it('一批里部分失败不影响其他条，失败原因挂回各自事件', async () => {
    const store = await freshStore();
    const app = createApp(store);
    // pay -> 假目标（可控返回码），dead -> 一个一定连不上的地址
    await request(app).put('/api/sources/pay').send({ replayTarget: target.url, signer: null });
    await request(app).put('/api/sources/dead').send({ replayTarget: 'http://127.0.0.1:9/cb', signer: null });

    const ok = await request(app).post('/hook/pay/a').send({ a: 1 });
    const badStatus = await request(app).post('/hook/pay/b').send({ b: 1 });
    const connFail = await request(app).post('/hook/dead/x').send({ c: 1 });
    // 重放时：/a 正常，/b 返回 500
    target.setBehavior(req => (req.url === '/b' ? 500 : 200));

    const res = await request(app).post('/api/replay').send({ ids: [ok.body.id, badStatus.body.id, connFail.body.id] });
    const byId = Object.fromEntries(res.body.results.map((r: any) => [r.id, r]));
    expect(byId[ok.body.id].ok).toBe(true);
    expect(byId[badStatus.body.id].status).toBe(500);
    expect(byId[badStatus.body.id].error).toContain('500');
    expect(byId[connFail.body.id].ok).toBe(false);
    expect(byId[connFail.body.id].error).toContain('无法连接');
  });

  it('未配置目标 / 事件不存在时跳过并给出原因', async () => {
    const store = await freshStore();
    const app = createApp(store);
    await request(app).put('/api/sources/pay').send({ replayTarget: null, signer: null });
    const cap = await request(app).post('/hook/pay/a').send({});
    const res = await request(app).post('/api/replay').send({ ids: [cap.body.id, 99999] });
    expect(res.body.results[0].skipped).toContain('目标');
    expect(res.body.results[1].skipped).toContain('不存在');
  });
});

describe('存储', () => {
  it('事件只留最近 500 条', async () => {
    const store = await freshStore();
    const app = createApp(store);
    await request(app).put('/api/sources/s').send({ replayTarget: null, signer: null });
    for (let i = 0; i < 505; i++) {
      await request(app).post('/hook/s').send({ i });
    }
    const events = (await request(app).get('/api/events')).body;
    expect(events).toHaveLength(500);
    expect(events[0].body.i).toBe(504); // 最新在前
    expect(events[499].body.i).toBe(5); // 最老的是第 6 条（i=5）
  });

  it('重启（重新 load 同一个文件）后事件、规则、来源、重放记录都还在', async () => {
    const target = await startFakeTarget();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'whlab-restart-'));
    const file = path.join(dir, 'db.json');

    const store1 = new Store(file);
    await store1.load();
    const app1 = createApp(store1);
    await request(app1).put('/api/sources/pay').send({ replayTarget: target.url, signer: null });
    await request(app1).put('/api/rules').send({ rules: phoneRules });
    const cap = await request(app1).post('/hook/pay/rt').send({ phone: '13800000000' });
    await request(app1).post('/api/replay').send({ ids: [cap.body.id] });
    await store1.flushed();

    const store2 = new Store(file);
    await store2.load();
    const app2 = createApp(store2);
    const sources = (await request(app2).get('/api/sources')).body;
    expect(sources[0].name).toBe('pay');
    expect(sources[0].replayTarget).toBe(target.url);
    const rules = (await request(app2).get('/api/rules')).body;
    expect(rules).toHaveLength(1);
    const events = (await request(app2).get('/api/events')).body;
    expect(events).toHaveLength(1);
    expect(events[0].replays).toHaveLength(1);
    expect(events[0].replays[0].status).toBe(200);
    await target.close();
  });

  it('after 补拉：返回 id 大于游标的事件且按 id 升序，不重不漏', async () => {
    const store = await freshStore();
    const app = createApp(store);
    await request(app).put('/api/sources/s').send({ signer: null });
    for (let i = 0; i < 3; i++) await request(app).post('/hook/s').send({ i });
    const res = await request(app).get('/api/events?after=1');
    expect(res.body.map((e: any) => e.id)).toEqual([2, 3]);
  });
});
