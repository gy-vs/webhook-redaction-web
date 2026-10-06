import type {EventRecord, ReplayRecord, Source} from '../shared/types';
import {redactStored} from './redact';

const REPLAY_TIMEOUT_MS = 15_000;

function joinUrl(base: string, pathWithQuery: string): string {
  // pathWithQuery starts with "/" and is relative to /hook/:source.
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleanBase}${pathWithQuery}`;
}

/**
 * Build the replay body from the stored (already redacted) snapshot, then
 * re-apply the CURRENT rules — changing a rule changes future replays.
 * Header rules are applied to the stored (redacted) header snapshot.
 */
function buildReplay(event: EventRecord, source: Source) {
  const safe = redactStored(event.headers, event.bodyKind, event.bodyTree, event.bodyText, source.rules);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(safe.headers)) {
    // Hop-by-hop headers that must not be forwarded.
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'transfer-encoding') continue;
    headers[name] = value;
  }
  return {
    url: joinUrl(source.targetUrl, event.path + (event.query ? `?${event.query}` : '')),
    headers,
    body: safe.text,
  };
}

export interface ReplayOutcome {
  eventId: number;
  replay: ReplayRecord;
}

/** Replay one event. Never throws; failure is encoded in the record. */
export async function replayOne(
  event: EventRecord,
  source: Source,
  idCounter: () => number,
): Promise<ReplayOutcome> {
  const started = Date.now();
  const base: ReplayRecord = {id: idCounter(), at: started, statusCode: null, durationMs: 0, ok: false};
  if (!source.targetUrl) {
    return {
      eventId: event.id,
      replay: {...base, durationMs: Date.now() - started, error: 'No target URL configured for this source.'},
    };
  }
  let request: ReturnType<typeof buildReplay>;
  try {
    request = buildReplay(event, source);
  } catch {
    return {
      eventId: event.id,
      replay: {...base, durationMs: Date.now() - started, error: 'Could not prepare the replay body.'},
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: event.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(event.method) ? undefined : request.body,
      signal: controller.signal,
    });
    // Drain the body so the connection can be reused; content is discarded.
    await response.arrayBuffer().catch(() => undefined);
    const durationMs = Date.now() - started;
    const ok = response.ok;
    return {
      eventId: event.id,
      replay: {
        ...base,
        durationMs,
        statusCode: response.status,
        ok,
        ...(ok ? {} : {error: `Target responded with HTTP ${response.status}.`}),
      },
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      eventId: event.id,
      replay: {
        ...base,
        durationMs,
        error: aborted ? `Target timed out after ${REPLAY_TIMEOUT_MS / 1000}s.` : 'Connection to target failed.',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
