import type {
  EventRecord,
  PathCheckResponse,
  PreviewResponse,
  ReplayResponseItem,
  Source,
  SourceView,
} from '../shared/types';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {'content-type': 'application/json', ...(init?.headers ?? {})},
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {error?: string; errors?: unknown} | null;
    throw new ApiError(res.status, body ?? {});
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  body: {error?: string; errors?: unknown};
  constructor(status: number, body: {error?: string; errors?: unknown}) {
    super(body.error || `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export const api = {
  state: () => jsonFetch<{sources: SourceView[]; maxEvents: number}>('/api/state'),
  saveSource: (source: Source) =>
    jsonFetch<{source: SourceView}>(`/api/sources/${encodeURIComponent(source.name)}`, {
      method: 'PUT',
      body: JSON.stringify(source),
    }),
  deleteSource: (name: string) =>
    jsonFetch<void>(`/api/sources/${encodeURIComponent(name)}`, {method: 'DELETE'}),
  events: (afterId?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (afterId !== undefined) params.set('afterId', String(afterId));
    if (limit !== undefined) params.set('limit', String(limit));
    const qs = params.toString();
    return jsonFetch<{events: EventRecord[]}>(`/api/events${qs ? `?${qs}` : ''}`);
  },
  event: (id: number) => jsonFetch<{event: EventRecord}>(`/api/events/${id}`),
  replay: (ids: number[]) =>
    jsonFetch<{results: ReplayResponseItem[]}>('/api/replay', {
      method: 'POST',
      body: JSON.stringify({ids}),
    }),
  preview: (body: {headers: Record<string, string>; contentType?: string; body: string; rules: Source['rules']}) =>
    jsonFetch<PreviewResponse>('/api/preview', {method: 'POST', body: JSON.stringify(body)}),
  checkPath: (path: string) =>
    jsonFetch<PathCheckResponse>('/api/check-path', {method: 'POST', body: JSON.stringify({path})}),
};
