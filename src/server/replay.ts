import type { EventRecord, RedactionRule, ReplayRecord, SourceDef } from '../shared/types.js';
import { applyRules } from './redaction.js';
import type { Store } from './store.js';

const REPLAY_TIMEOUT_MS = 10_000;

/** 把来源配置的目标地址与事件原始子路径拼起来（去掉 /hook/<来源> 前缀）。 */
export function buildTargetUrl(source: SourceDef, event: EventRecord): string {
  const base = source.replayTarget!.replace(/\/+$/, '');
  const prefix = `/hook/${encodePath(source.name)}`;
  let sub = event.path;
  if (sub.toLowerCase().startsWith(prefix.toLowerCase())) sub = sub.slice(prefix.length);
  if (!sub.startsWith('/')) sub = '/' + sub;
  return base + sub;
}

function encodePath(name: string) {
  return name.split('/').map(encodeURIComponent).join('/');
}

/** 按当前规则重新处理已存事件，再序列化为即将发出的请求。 */
export function prepareReplay(
  event: EventRecord,
  rules: RedactionRule[],
): { init: RequestInit; bodySize: number } {
  const reprocessed = applyRules(
    { bodyKind: event.bodyKind, body: event.body, rawText: event.rawText },
    event.headers,
    rules,
  );

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(reprocessed.headers)) {
    if (['host', 'content-length', 'connection'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }

  let payload: BodyInit | undefined;
  const b = reprocessed.body;
  if (b.bodyKind === 'json') {
    payload = JSON.stringify(b.body);
    headers['content-type'] = event.contentType ?? 'application/json';
  } else if (b.bodyKind === 'form') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries((b.body ?? {}) as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(x => params.append(k, String(x)));
      else params.set(k, String(v));
    }
    payload = params.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (b.bodyKind === 'multipart') {
    const form = new FormData();
    for (const [k, v] of Object.entries((b.body ?? {}) as Record<string, unknown>)) {
      const append = (x: unknown) => {
        if (x && typeof x === 'object' && '__file' in x) return; // 文件字节未留存，无法重放
        form.append(k, String(x));
      };
      if (Array.isArray(v)) v.forEach(append);
      else append(v);
    }
    payload = form; // fetch 自动带 multipart boundary
    delete headers['content-type'];
  } else if (b.bodyKind === 'text' && b.rawText !== null) {
    payload = b.rawText;
    if (event.contentType) headers['content-type'] = event.contentType;
  }

  return {
    init: { method: event.method, headers, body: payload },
    bodySize: typeof payload === 'string' ? Buffer.byteLength(payload) : -1,
  };
}

export async function replayOne(
  store: Store,
  event: EventRecord,
  source: SourceDef,
  rules: RedactionRule[],
  publishUpdate: (e: EventRecord) => void,
): Promise<{ record: ReplayRecord }> {
  const target = buildTargetUrl(source, event);
  const prepared = prepareReplay(event, rules);

  const record: ReplayRecord = {
    at: new Date().toISOString(),
    target,
    status: null,
    durationMs: 0,
    ok: false,
    error: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  const start = Date.now();
  try {
    const response = await fetch(target, { ...prepared.init, signal: controller.signal } as RequestInit);
    record.durationMs = Date.now() - start;
    record.status = response.status;
    record.ok = response.ok;
    if (!response.ok) record.error = `目标返回 HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`;
    // 消费掉响应体，避免连接悬挂；不保存，防止目标响应里夹带敏感值
    await response.arrayBuffer().catch(() => undefined);
  } catch (e: any) {
    record.durationMs = Date.now() - start;
    record.ok = false;
    if (e?.name === 'AbortError') {
      record.error = `重放超时（${REPLAY_TIMEOUT_MS / 1000}s）`;
    } else {
      // 只保留错误类别，不回显可能含细节的 message（URL/证书串等）
      record.error = `无法连接目标（${e?.code ?? 'network error'}）`;
    }
  } finally {
    clearTimeout(timer);
  }

  const updated = store.getEvent(event.id) ?? event;
  updated.replays.push(record);
  store.updateEvent(updated);
  publishUpdate(updated);
  return { record };
}

/** 批量重放：每条独立结算，任何一条失败不影响其他条。 */
export async function replayMany(
  store: Store,
  ids: number[],
  rules: RedactionRule[],
  publishUpdate: (e: EventRecord) => void,
): Promise<{ id: number; event: EventRecord | null; record: ReplayRecord | null; skipped: string | null }[]> {
  return Promise.all(ids.map(async id => {
    const event = store.getEvent(id);
    if (!event) return { id, event: null, record: null, skipped: '事件不存在（可能已被 500 条上限淘汰）' };
    const source = store.getSource(event.source);
    if (!source) return { id, event: null, record: null, skipped: '来源已被删除' };
    if (!source.replayTarget) return { id, event: null, record: null, skipped: '来源未配置重放目标地址' };
    const { record } = await replayOne(store, event, source, rules, publishUpdate);
    return { id, event: store.getEvent(id) ?? null, record, skipped: null };
  }));
}
