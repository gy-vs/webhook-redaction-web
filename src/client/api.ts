import type {
  EventRecord, RedactionRule, SourceView,
} from '../shared/types';

export interface PreviewResult {
  errors: { ruleId: string; message: string; column?: number }[];
  before: { bodyKind: string; body: unknown; rawText: string | null };
  after: { bodyKind: string; body: unknown; rawText: string | null; headers: Record<string, string> };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init?.headers,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.error ?? `请求失败（HTTP ${res.status}）`;
    const detail = data?.errors?.map((e: any) => e.message).join('；');
    throw new Error(detail ? `${msg}：${detail}` : msg);
  }
  return data;
}

export const api = {
  listEventsDesc: () => jsonFetch('/api/events') as Promise<EventRecord[]>,
  listSources: () => jsonFetch('/api/sources') as Promise<SourceView[]>,
  putSource: (name: string, body: unknown) =>
    jsonFetch(`/api/sources/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(body) }) as Promise<SourceView>,
  deleteSource: (name: string) => jsonFetch(`/api/sources/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listRules: () => jsonFetch('/api/rules') as Promise<RedactionRule[]>,
  putRules: (rules: RedactionRule[]) =>
    jsonFetch('/api/rules', { method: 'PUT', body: JSON.stringify({ rules }) }) as Promise<RedactionRule[]>,
  replay: (ids: number[]) =>
    jsonFetch('/api/replay', { method: 'POST', body: JSON.stringify({ ids }) }),
  preview: (payload: unknown): Promise<PreviewResult> =>
    jsonFetch('/api/preview', { method: 'POST', body: JSON.stringify(payload) }),
};

export interface StreamHandlers {
  onOpen: () => void;
  onDisconnect: () => void;
  onEvent: (e: EventRecord) => void;
  onReplay: (e: EventRecord) => void;
}

/**
 * SSE 长连接：
 * - 连接 URL 始终带 after=当前最大 id，服务端在建立连接时补发错过的事件，
 *   合盖半小时 / 网络抖动都不会丢；
 * - 帧按事件 id 在本地按 id 去重，乱序帧重排；
 * - 浏览器自动重连之外，页面重新可见时主动触发重连。
 */
export function openStream(getAfter: () => number, handlers: StreamHandlers): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api/stream?after=${getAfter()}`);
    es.onopen = () => handlers.onOpen();
    es.addEventListener('event', ev => {
      handlers.onEvent(JSON.parse((ev as MessageEvent).data));
    });
    es.addEventListener('replay', ev => {
      handlers.onReplay(JSON.parse((ev as MessageEvent).data));
    });
    es.onerror = () => {
      handlers.onDisconnect();
      es?.close();
      if (!closed) retry = setTimeout(connect, 1500);
    };
  };
  connect();

  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      es?.close();
      if (retry) clearTimeout(retry);
      connect();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
