import {useState, type ReactNode} from 'react';
import {RotateCcw, ChevronDown, ChevronRight} from 'lucide-react';
import type {EventRecord} from '../../shared/types';
import SigBadge from './SigBadge';

function BodyView({event}: { event: EventRecord }) {
  if (event.bodyKind === 'empty') return <p className="muted">（无正文）</p>;
  if (event.bodyKind === 'text') {
    return (
      <>
        <div className="kind-hint">按纯文本记录 · {event.contentType ?? '未知 Content-Type'}</div>
        <pre className="body-pre">{event.rawText ?? ''}</pre>
      </>
    );
  }
  return (
    <>
      <div className="kind-hint">
        {event.bodyKind === 'json' ? 'JSON 正文' : event.bodyKind === 'form' ? '表单 application/x-www-form-urlencoded' : 'multipart 表单'}
      </div>
      <pre className="body-pre">{JSON.stringify(event.body, null, 2)}</pre>
    </>
  );
}

function Section({title, children, defaultOpen = true}: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export default function EventDetail({event, onReplay, busy}: {
  event: EventRecord;
  onReplay: (ids: number[]) => void;
  busy: boolean;
}) {
  const v = event.verification;
  return (
    <div className="detail">
      <div className="detail-top">
        <div>
          <h2><b>{event.method}</b> {event.path}</h2>
          <small className="muted">#{event.id} · 来源 {event.source} · {new Date(event.receivedAt).toLocaleString()}</small>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => onReplay([event.id])}>
          <RotateCcw size={14} /> 重放到本地目标
        </button>
      </div>

      <Section title="签名结论">
        <SigBadge status={v.status} />
        <table className="kv">
          <tbody>
            {v.header && <tr><td>签名头</td><td>{v.header}</td></tr>}
            {v.signatureReceived !== undefined && <tr><td>收到的签名</td><td><code>{v.signatureReceived}</code></td></tr>}
            {v.matchedSecretLabel && <tr><td>匹配的密钥</td><td>{v.matchedSecretLabel}</td></tr>}
            {v.timestamp !== undefined && <tr><td>时间戳</td><td><code>{v.timestamp}</code></td></tr>}
            {v.note && <tr><td>说明</td><td className="warn-text">{v.note}</td></tr>}
          </tbody>
        </table>
        <p className="hint">校验始终在服务端对原始请求字节计算，前端只展示结论。</p>
      </Section>

      <Section title="请求头">
        <table className="kv headers">
          <tbody>
            {Object.entries(event.headers).map(([k, val]) => (
              <tr key={k}><td className="hn">{k}</td><td><code>{val}</code></td></tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="正文">
        <BodyView event={event} />
      </Section>

      <Section title={`重放记录（${event.replays.length}）`} defaultOpen={event.replays.length > 0}>
        {event.replays.length === 0 ? <p className="muted">还没有重放过</p> : (
          <table className="replays">
            <thead><tr><th>时间</th><th>目标</th><th>状态码</th><th>耗时</th><th>结果</th></tr></thead>
            <tbody>
              {event.replays.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.at).toLocaleTimeString()}</td>
                  <td className="target">{r.target}</td>
                  <td>{r.status ?? '—'}</td>
                  <td>{r.durationMs}ms</td>
                  <td>{r.ok
                    ? <span className="ok-text">成功</span>
                    : <span className="bad-text">{r.error ?? '失败'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
