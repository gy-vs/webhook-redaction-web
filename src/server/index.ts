import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  EventRecord, RedactionRule, SecretDef, SignerConfig, SignerInput, SourceDef, SourceView,
} from '../shared/types.js';
import { parseBody } from './bodyParser.js';
import { applyRules, validateRules } from './redaction.js';
import { verifySignature } from './signature.js';
import { Store } from './store.js';
import { replayMany } from './replay.js';

const MAX_BODY_BYTES = 1024 * 1024;
const NAME_RE = /^[\w一-鿿-]+$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.WEBHOOK_DB ?? path.join(__dirname, '..', '..', 'data', 'webhook.json');
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');

type Listeners = Set<express.Response>;

export function createApp(store = new Store(DATA_FILE)) {
  const app = express();
  app.disable('x-powered-by');
  // 只给配置类 API 用 body 解析；/hook 必须自己按原始字节读取（验签依赖字节）
  app.use('/api', express.json({ limit: '2mb' }));

  const listeners: Listeners = new Set();

  function publishFrame(event: string, payload: unknown, id?: number) {
    const idLine = id !== undefined ? `id: ${id}\n` : '';
    const frame = `${idLine}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of listeners) res.write(frame);
  }
  const publishNew = (e: EventRecord) => publishFrame('event', e, e.id);
  const publishReplay = (e: EventRecord) => publishFrame('replay', e);

  // ---------- 工具 ----------

  function toView(s: SourceDef): SourceView {
    return {
      name: s.name,
      replayTarget: s.replayTarget,
      createdAt: s.createdAt,
      signer: s.signer
        ? {
            ...s.signer,
            secrets: s.signer.secrets.map(x => ({ id: x.id, label: x.label })),
          }
        : null,
    };
  }

  /** 入参与已存密钥合并：secret 留空 = 沿用原值；提供了 = 换值；列表里消失 = 删除。 */
  function mergeSigner(input: SignerInput, existing: SignerConfig | null): SignerConfig | { error: string } {
    const header = input.header?.trim();
    if (!header) return { error: '签名头名不能为空' };
    if (!['sha1', 'sha256', 'sha512'].includes(input.algorithm)) return { error: '不支持的 HMAC 算法' };
    if (!['hex', 'base64'].includes(input.encoding)) return { error: '不支持的签名编码' };
    const skew = Number(input.timestampSkewSeconds);
    if (!Number.isFinite(skew) || skew < 0) return { error: '允许时间偏差必须是非负数（秒）' };
    if (!Array.isArray(input.secrets) || input.secrets.length === 0) return { error: '至少需要一把密钥' };

    const secrets: SecretDef[] = [];
    for (const item of input.secrets) {
      if (!item.label?.trim()) return { error: '每把密钥都要有标签（如 old / new）' };
      const provided = item.secret ?? '';
      if (provided) {
        secrets.push({ id: item.id, label: item.label.trim(), secret: provided });
      } else {
        const old = existing?.secrets.find(s => s.id === item.id);
        if (!old) return { error: `密钥 ${item.label} 是新增的，必须填写密钥内容` };
        secrets.push({ id: old.id, label: item.label.trim(), secret: old.secret });
      }
    }

    const tsHeader = input.timestampHeader?.trim() || null;
    return {
      header,
      algorithm: input.algorithm,
      encoding: input.encoding,
      secrets,
      timestampHeader: tsHeader,
      timestampSkewSeconds: skew,
    };
  }

  function decodeHeaderValue(latin1: string): string {
    // HTTP 头在 Node 里按 latin1 给出；对方通常发的是 UTF-8 字节，尝试按 UTF-8 还原，
    // 不是合法 UTF-8（纯 ASCII / 确实的 latin1 字节）时原样保留。
    const bytes = Buffer.from(latin1, 'latin1');
    const utf8 = bytes.toString('utf8');
    if (!utf8.includes('�')) return utf8;
    return latin1;
  }

  function rawHeaders(req: express.Request): Record<string, string> {
    const out: Record<string, string> = {};
    const pairs = req.rawHeaders;
    for (let i = 0; i < pairs.length; i += 2) {
      const name = pairs[i]!;
      const value = decodeHeaderValue(pairs[i + 1]!);
      const key = Object.keys(out).find(k => k.toLowerCase() === name.toLowerCase());
      if (key === undefined) out[name] = value;
      else out[key] += ', ' + value;
    }
    return out;
  }

  function readRaw(req: express.Request): Promise<{ tooLarge: true } | { tooLarge: false; buffer: Buffer }> {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      let settled = false;
      req.on('data', (chunk: Buffer) => {
        if (over) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          over = true; // 后续字节直接丢弃（保持流动，避免 RST 让对端收不到响应）
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(over ? { tooLarge: true } : { tooLarge: false, buffer: Buffer.concat(chunks) });
      });
      req.on('error', () => {
        if (settled) return;
        settled = true;
        resolve({ tooLarge: true });
      });
    });
  }

  // ---------- 回调接收 ----------

  const capture = async (req: express.Request, res: express.Response) => {
    const name = decodeURIComponent(String(req.params.name ?? ''));
    const source = store.getSource(name);
    if (!source) {
      res.status(404).json({ error: `来源 ${name} 未登记` });
      return;
    }

    const read = await readRaw(req);
    if (read.tooLarge) {
      // 超限：立即拒绝，不解析、不验签、不留任何记录
      res.status(413).json({ error: '请求正文超过 1MB 限制' });
      return;
    }
    const raw = read.buffer;
    const headers = rawHeaders(req);
    const contentType = req.header('content-type') ?? null;

    const verification = verifySignature(raw, headers, source.signer);
    const parsed = parseBody(raw, contentType);
    const reprocessed = applyRules(parsed, headers, store.getRules());

    const event: EventRecord = {
      id: store.nextId(),
      source: name,
      receivedAt: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      headers: reprocessed.headers,
      contentType,
      bodyKind: reprocessed.body.bodyKind,
      body: reprocessed.body.body,
      rawText: reprocessed.body.rawText,
      verification,
      replays: [],
    };
    store.addEvent(event);
    publishNew(event);
    res.status(202).json({ id: event.id });
  };

  app.all(['/hook/:name', '/hook/:name/*path'], (req, res, next) => {
    capture(req, res).catch(next);
  });

  // ---------- 配置：来源 ----------

  app.get('/api/sources', (_req, res) => {
    res.json(store.getSources().map(toView));
  });

  app.put('/api/sources/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name ?? '');
    if (!NAME_RE.test(name)) {
      res.status(400).json({ error: '来源名只能含字母、数字、下划线、连字符和中文' });
      return;
    }
    const body = req.body ?? {};
    const target = typeof body.replayTarget === 'string' && body.replayTarget.trim()
      ? body.replayTarget.trim() : null;
    if (target && !/^https?:\/\/.+/.test(target)) {
      res.status(400).json({ error: '重放目标地址必须是 http(s):// 开头的完整地址' });
      return;
    }
    const existing = store.getSource(name);
    let signer: SignerConfig | null = null;
    if (body.signer) {
      const merged = mergeSigner(body.signer as SignerInput, existing?.signer ?? null);
      if ('error' in merged) { res.status(400).json({ error: merged.error }); return; }
      signer = merged;
    }
    const def: SourceDef = {
      name,
      replayTarget: target,
      signer,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    store.upsertSource(def);
    res.json(toView(def));
  });

  app.delete('/api/sources/:name', (req, res) => {
    store.deleteSource(decodeURIComponent(req.params.name ?? ''));
    res.status(204).end();
  });

  // ---------- 配置：规则 ----------

  app.get('/api/rules', (_req, res) => res.json(store.getRules()));

  app.put('/api/rules', (req, res) => {
    const rules = Array.isArray(req.body?.rules) ? (req.body.rules as RedactionRule[]) : null;
    if (!rules) { res.status(400).json({ error: '请求体需要 { rules: [...] }' }); return; }
    const errors = validateRules(rules);
    if (errors.length > 0) {
      res.status(400).json({ error: '规则校验未通过', errors });
      return;
    }
    store.setRules(rules);
    res.json(store.getRules());
  });

  // ---------- 规则页：样例预览 ----------

  app.post('/api/preview', (req, res) => {
    const { rawText, contentType, headerPairs, rules } = req.body ?? {};
    if (typeof rawText !== 'string') { res.status(400).json({ error: 'rawText 必须是字符串' }); return; }
    const headerMap: Record<string, string> = {};
    if (Array.isArray(headerPairs)) {
      for (const pair of headerPairs) {
        if (pair && typeof pair.name === 'string' && typeof pair.value === 'string' && pair.name) {
          headerMap[pair.name] = pair.value;
        }
      }
    }
    const ruleList: RedactionRule[] = Array.isArray(rules) ? rules : [];
    const errors = validateRules(ruleList);
    const raw = Buffer.from(rawText, 'utf8');
    const ct = typeof contentType === 'string' ? contentType : null;
    const before = parseBody(raw, ct);
    const after = applyRules(before, headerMap, ruleList);
    res.json({
      errors,
      before: { contentType: ct, ...before },
      after: { contentType: ct, ...after.body, headers: after.headers },
    });
  });

  // ---------- 事件 ----------

  app.get('/api/events', (req, res) => {
    const after = Number(req.query.after);
    if (Number.isFinite(after) && after > 0) {
      res.json(store.getEventsAfter(after)); // 升序，用于补漏
    } else {
      res.json(store.getEventsDesc()); // 首屏倒序
    }
  });

  // ---------- 重放 ----------

  app.post('/api/replay', async (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: unknown) => Number.isInteger(x) && (x as number) > 0) : [];
    if (ids.length === 0) { res.status(400).json({ error: '需要至少一个事件 id' }); return; }
    const results = await replayMany(store, ids, store.getRules(), publishReplay);
    res.json({
      results: results.map(r => ({
        id: r.id,
        event: r.event,
        skipped: r.skipped,
        status: r.record?.status ?? null,
        durationMs: r.record?.durationMs ?? null,
        ok: r.record?.ok ?? false,
        error: r.record?.error ?? null,
      })),
    });
  });

  // ---------- 实时推送 ----------

  app.get('/api/stream', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders?.();
    res.write(': connected\n\n'); // 注释行，立刻建立流

    // 优先用查询参数里的 after（首屏列表拿到的最大 id），其次浏览器自动带的 Last-Event-ID
    const queryAfter = Number(req.query.after);
    let afterId = Number.isFinite(queryAfter) && queryAfter >= 0 ? queryAfter : NaN;
    if (!Number.isFinite(afterId)) {
      const last = req.header('last-event-id');
      if (last && /^\d+$/.test(last)) afterId = Number(last);
    }
    if (Number.isFinite(afterId)) {
      for (const missed of store.getEventsAfter(afterId)) {
        res.write(`id: ${missed.id}\nevent: event\ndata: ${JSON.stringify(missed)}\n\n`);
      }
    }

    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); listeners.delete(res); });
  });

  // ---------- 静态前端（生产模式） ----------

  app.use(express.static(DIST_DIR));
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/hook/')) return next();
    try {
      await fs.access(path.join(DIST_DIR, 'index.html'));
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    } catch { next(); }
  });

  return app;
}

export { DATA_FILE, Store };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new Store(DATA_FILE);
  store.load().then(() => {
    createApp(store).listen(4174, '127.0.0.1', () => console.log('webhook 调试台 http://127.0.0.1:4174'));
  }).catch(err => {
    console.error('启动失败:', err?.message ?? err);
    process.exit(1);
  });
}
