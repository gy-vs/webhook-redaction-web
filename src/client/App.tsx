import {useCallback, useEffect, useRef, useState} from 'react';
import {Radio, ListChecks, Settings2, ShieldCheck} from 'lucide-react';
import type {EventRecord} from '../shared/types';
import {api, openStream} from './api';
import EventsView from './views/EventsView';
import SourcesView from './views/SourcesView';
import RulesView from './views/RulesView';

type Tab = 'events' | 'sources' | 'rules';

/** 按 id 去重后，按 id 降序插入（id 单调递增，新事件总在最前）。 */
function mergeIncoming(list: EventRecord[], incoming: EventRecord | EventRecord[]): EventRecord[] {
  const items = Array.isArray(incoming) ? incoming : [incoming];
  const map = new Map(list.map(e => [e.id, e]));
  for (const e of items) map.set(e.id, e);
  return [...map.values()].sort((a, b) => b.id - a.id).slice(0, 500);
}

export default function App() {
  const [tab, setTab] = useState<Tab>('events');
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const eventsRef = useRef<EventRecord[]>([]);
  eventsRef.current = events;
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.listEventsDesc().then(rows => setEvents(rows)).catch(e => setNotice(String(e.message ?? e)));
    const close = openStream(
      () => eventsRef.current.reduce((m, e) => Math.max(m, e.id), 0),
      {
        onOpen: () => setConnected(true),
        onDisconnect: () => setConnected(false),
        onEvent: e => setEvents(rows => mergeIncoming(rows, e)),
        onReplay: e => setEvents(rows => rows.map(x => (x.id === e.id ? e : x))),
      },
    );
    return () => { close(); };
  }, []);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  }, []);

  const replaceEvent = useCallback((e: EventRecord) => {
    setEvents(rows => rows.map(x => (x.id === e.id ? e : x)));
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <Radio size={20} />
        <span className="brand">Webhook 调试台</span>
        <small>收 · 验 · 存 · 转发（本地）</small>
        <span className={`conn ${connected ? 'on' : 'off'}`}>
          <i /> {connected ? '实时连接中' : '连接中断，重连中…'}
        </span>
        <nav className="tabs">
          <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}><ListChecks size={15} /> 事件</button>
          <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><Settings2 size={15} /> 来源</button>
          <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}><ShieldCheck size={15} /> 脱敏规则</button>
        </nav>
      </header>
      {notice && <div className="notice">{notice}</div>}
      {tab === 'events' && <EventsView events={events} onReplayed={replaceEvent} onError={flash} />}
      {tab === 'sources' && <SourcesView onError={flash} onSaved={flash} />}
      {tab === 'rules' && <RulesView onError={flash} onSaved={flash} />}
    </main>
  );
}
