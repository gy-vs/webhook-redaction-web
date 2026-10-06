import {useCallback, useEffect, useRef, useState} from 'react';
import type {EventRecord, ReplayRecord, SourceView} from '../shared/types';
import {api} from './api';

type EventMap = Map<number, EventRecord>;

function sorted(events: EventMap): EventRecord[] {
  return [...events.values()].sort((a, b) => b.id - a.id);
}

interface StreamFrame {
  type: 'event' | 'replay' | 'sources';
  event?: EventRecord;
  eventId?: number;
  replay?: ReplayRecord;
  sources?: SourceView[];
}

/**
 * Keeps the event list correct across flaky wifi and laptop naps:
 *  - SSE frames are upserted by id (new frames + server backfill after
 *    Last-Event-ID are handled identically).
 *  - On every (re)connect we also reconcile via /api/events?afterId=, so a
 *    frame missed during a reconnection gap is still recovered.
 *  - Ordering is always by id; duplicates are impossible.
 */
export function useLiveData() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [connected, setConnected] = useState(false);
  const seenRef = useRef<EventMap>(new Map());
  const sourcesRef = useRef<SourceView[]>([]);

  const upsertEvent = useCallback((event: EventRecord) => {
    seenRef.current.set(event.id, event);
    setEvents(sorted(seenRef.current));
  }, []);

  const patchReplay = useCallback((eventId: number, replay: ReplayRecord) => {
    const existing = seenRef.current.get(eventId);
    if (existing) {
      const updated = {...existing, replays: [...existing.replays, replay]};
      seenRef.current.set(eventId, updated);
      setEvents(sorted(seenRef.current));
    } else {
      // Event aged out of the local list while a replay answer was in flight.
      api.event(eventId).then(({event}) => upsertEvent(event)).catch(() => undefined);
    }
  }, [upsertEvent]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    api.state().then((state) => {
      if (cancelled) return;
      sourcesRef.current = state.sources;
      setSources(state.sources);
    });
    api.events(undefined, 500).then(({events: rows}) => {
      if (cancelled) return;
      for (const row of rows) seenRef.current.set(row.id, row);
      setEvents(sorted(seenRef.current));
    });

    const connect = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => setConnected(true);
      es.addEventListener('event', (msg: MessageEvent) => {
        const frame = JSON.parse(msg.data) as StreamFrame;
        if (frame.event) upsertEvent(frame.event);
      });
      es.addEventListener('replay', (msg: MessageEvent) => {
        const frame = JSON.parse(msg.data) as StreamFrame;
        if (frame.eventId && frame.replay) patchReplay(frame.eventId, frame.replay);
      });
      es.addEventListener('sources', (msg: MessageEvent) => {
        const frame = JSON.parse(msg.data) as StreamFrame;
        if (frame.sources) {
          sourcesRef.current = frame.sources;
          setSources(frame.sources);
        }
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        // Browser reconnects on its own, but we also force a fresh channel
        // and a gap-fill fetch after a short pause (covers laptop sleep).
        reconnectTimer = setTimeout(() => {
          const highest = Math.max(0, ...seenRef.current.keys() as unknown as number[]);
          api.events(highest).then(({events: rows}) => {
            for (const row of rows) upsertEvent(row);
          }).catch(() => undefined);
          connect();
        }, 1500);
      };
    };
    connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        const highest = seenRef.current.size ? Math.max(...seenRef.current.keys()) : 0;
        api.events(highest).then(({events: rows}) => {
          for (const row of rows) upsertEvent(row);
        }).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [upsertEvent, patchReplay]);

  return {events, sources, connected, upsertEvent};
}
