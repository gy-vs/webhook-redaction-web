import {useState} from 'react';
import {RotateCcw, Inbox} from 'lucide-react';
import type {EventRecord, SigStatus} from '../../shared/types';
import {api} from '../api';
import SigBadge from '../components/SigBadge';
import EventDetail from '../components/EventDetail';

interface Props {
  events: EventRecord[];
  onReplayed: (e: EventRecord) => void;
  onError: (msg: string) => void;
}

export default function EventsView({events, onReplayed, onError}: Props) {
  const [selected, setSelected] = useState<number[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const open = events.find(e => e.id === openId) ?? null;

  const toggle = (id: number) => setSelected(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]));

  async function replay(ids: number[]) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      const data = await api.replay(ids);
      for (const r of data.results) if (r.event) onReplayed(r.event);
      const failed = data.results.filter((r: any) => r.skipped || !r.ok).length;
      onError(failed === 0 ? `${ids.length} 条重放完成，均成功` : `${ids.length} 条重放完成，${failed} 条失败/跳过，见各事件的重放记录`);
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const replayableCount = selected.length;

  return (
    <section className="workspace">
      <aside className="pane list-pane">
        <div className="pane-head">
          <h2>事件 <small>{events.length}/500</small></h2>
          <button className="btn" disabled={selected.length === 0 || busy} onClick={() => replay(selected)}>
            <RotateCcw size={14} /> 重放选中（{selected.length}）
          </button>
        </div>
        {selected.length > 0 && (
          <div className="selectbar">
            <button className="link" onClick={() => setSelected([])}>清除选择</button>
            <span>{replayableCount} 条待重放</span>
          </div>
        )}
        <div className="list">
          {events.length === 0 && <div className="empty"><Inbox size={28} /><p>还没有回调</p><small>先在「来源」页登记，再把请求打到 /hook/来源名/…</small></div>}
          {events.map(e => (
            <div key={e.id} className={`row ${openId === e.id ? 'active' : ''}`}>
              <label className="check" onClick={ev => ev.stopPropagation()}>
                <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} />
              </label>
              <button className="row-body" onClick={() => setOpenId(e.id)}>
                <span className="line1"><b>{e.method}</b> <span className="path">{e.path}</span></span>
                <span className="line2">
                  <SigBadge status={e.verification.status as SigStatus} />
                  <small>#{e.id} · {e.source} · {new Date(e.receivedAt).toLocaleTimeString()}</small>
                </span>
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section className="pane detail-pane">
        {open ? <EventDetail event={open} onReplay={replay} busy={busy} /> : <div className="empty big"><Inbox size={36} /><p>选择左侧事件查看详情</p></div>}
      </section>
    </section>
  );
}
