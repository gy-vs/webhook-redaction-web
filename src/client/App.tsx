import {useMemo, useState} from 'react';
import {Plus, Radio, RefreshCw, Settings, Trash2, Wifi, WifiOff} from 'lucide-react';
import {api} from './api';
import {EventDetail} from './EventDetail';
import {SourceEditor} from './SourceEditor';
import {useLiveData} from './useLiveData';
import type {EventRecord} from '../shared/types';

const VERIFY_DOT: Record<string, string> = {
  valid: 'dot-good',
  mismatch: 'dot-bad',
  malformed_signature: 'dot-bad',
  timestamp_invalid: 'dot-bad',
  timestamp_skew: 'dot-bad',
  missing_signature: 'dot-warn',
  not_configured: 'dot-neutral',
};

function timeShort(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', {hour12: false});
}

export default function App() {
  const {events, sources, connected} = useLiveData();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [showSources, setShowSources] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [replayingIds, setReplayingIds] = useState<Set<number>>(new Set());

  const visible = useMemo(
    () => (sourceFilter ? events.filter((e) => e.source === sourceFilter) : events),
    [events, sourceFilter],
  );
  const selected: EventRecord | null = useMemo(() => {
    if (selectedId !== null) return events.find((e) => e.id === selectedId) ?? null;
    return visible[0] ?? null;
  }, [events, visible, selectedId]);

  function openEditor(name: string | null) {
    setEditing(name);
    setEditorOpen(true);
  }

  function toggleBatch(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function replay(ids: number[]) {
    if (ids.length === 0) return;
    setReplayingIds((prev) => new Set(prev).add(-1));
    ids.forEach((id) => setReplayingIds((prev) => new Set(prev).add(id)));
    try {
      await api.replay(ids);
      // SSE pushes the results; refetch selected event shortly to be safe.
      setTimeout(() => {
        for (const id of ids) {
          api.event(id).catch(() => undefined);
        }
      }, 400);
    } catch (err) {
      alert(`重放失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReplayingIds((prev) => {
        const next = new Set(prev);
        next.delete(-1);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Radio size={20}/>
        <span className="brand">Webhook 调试台</span>
        <small>收 · 验 · 存 · 转发</small>
        <div className="topbar-right">
          <span className={`conn ${connected ? 'on' : 'off'}`}>
            {connected ? <Wifi size={15}/> : <WifiOff size={15}/>}
            {connected ? '实时连接' : '重连中'}
          </span>
          <button className="topbtn" onClick={() => setShowSources((v) => !v)}>
            <Settings size={15}/> 来源与规则
          </button>
        </div>
      </header>

      {showSources && (
        <div className="source-bar">
          {sources.length === 0 && <span className="muted">还没有来源，先登记一个。</span>}
          {sources.map((s) => (
            <div className="source-chip" key={s.name}>
              <button className="chip-name" onClick={() => setSourceFilter((f) => (f === s.name ? '' : s.name))}>
                <span className={`chip-dot ${sourceFilter === s.name ? 'on' : ''}`}/>
                {s.name}
                <small>/hook/{s.name}/…</small>
                {s.signature ? '' : <small className="muted">（无签名）</small>}
              </button>
              <button className="icon-btn" title="编辑" onClick={() => openEditor(s.name)}><Settings size={14}/></button>
              <button
                className="icon-btn"
                title="删除"
                onClick={async () => {
                  if (confirm(`删除来源 ${s.name}？历史事件保留。`)) {
                    await api.deleteSource(s.name);
                    if (sourceFilter === s.name) setSourceFilter('');
                  }
                }}
              >
                <Trash2 size={14}/>
              </button>
            </div>
          ))}
          <button className="topbtn" onClick={() => openEditor(null)}><Plus size={14}/> 登记新来源</button>
        </div>
      )}

      <section className="workspace">
        <aside className="pane list-pane">
          <div className="list-head">
            <h2>事件 {events.length > 0 && <small>（保留最近 500 条）</small>}</h2>
            {selectedIds.size > 0 && (
              <button className="primary small" onClick={() => { void replay([...selectedIds]); setSelectedIds(new Set()); }}>
                <RefreshCw size={13}/> 重放选中 {selectedIds.size} 条
              </button>
            )}
          </div>
          <div className="list">
            {visible.map((event) => (
              <div
                key={event.id}
                className={`event-row ${selected?.id === event.id ? 'active' : ''}`}
                onClick={() => setSelectedId(event.id)}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(event.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleBatch(event.id)}
                />
                <span className={`dot ${VERIFY_DOT[event.verification.status]}`} title={event.verification.status}/>
                <div className="event-meta">
                  <strong>{event.method} {event.path.length > 42 ? `${event.path.slice(0, 42)}…` : event.path}</strong>
                  <small>{event.source} · {timeShort(event.receivedAt)}{event.replays.length > 0 && ` · 重放×${event.replays.length}`}</small>
                </div>
              </div>
            ))}
            {visible.length === 0 && <p className="muted">等待回调……把对方的地址指到 /hook/来源名/ 即可。</p>}
          </div>
        </aside>

        <EventDetail
          event={selected}
          replaying={selected !== null && replayingIds.has(selected.id)}
          onReplay={() => selected && void replay([selected.id])}
        />
      </section>

      {editorOpen && (
        <SourceEditor
          sources={sources}
          edited={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => setShowSources(true)}
        />
      )}
    </main>
  );
}
