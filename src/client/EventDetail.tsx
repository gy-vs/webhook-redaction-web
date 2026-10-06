import {RotateCcw} from 'lucide-react';
import type {EventRecord, VerifyStatus} from '../shared/types';

const STATUS_TEXT: Record<VerifyStatus, {label: string; tone: string}> = {
  not_configured: {label: '未配置签名', tone: 'neutral'},
  missing_signature: {label: '请求未带签名', tone: 'warn'},
  timestamp_invalid: {label: '时间戳缺失或格式不对', tone: 'bad'},
  timestamp_skew: {label: '时间戳超出允许窗口', tone: 'bad'},
  malformed_signature: {label: '签名格式不对', tone: 'bad'},
  mismatch: {label: '签名对不上', tone: 'bad'},
  valid: {label: '签名通过', tone: 'good'},
};

function time(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {hour12: false});
}

export function EventDetail({event, onReplay, replaying}: {event: EventRecord | null; onReplay: () => void; replaying: boolean}) {
  if (!event) {
    return <section className="pane detail empty-detail"><p className="muted">选择左侧事件查看详情。</p></section>;
  }
  const status = STATUS_TEXT[event.verification.status];
  return (
    <section className="pane detail">
      <div className="toolbar">
        <button className="primary" onClick={onReplay} disabled={replaying}>
          <RotateCcw size={15}/> {replaying ? '重放中…' : '重放到目标'}
        </button>
        <span className="muted">#{event.id} · {time(event.receivedAt)}</span>
      </div>

      <h2>{event.method} /hook/{event.source}{event.path}{event.query ? `?${event.query}` : ''}</h2>
      <p className="muted">正文 {event.bodyBytes} 字节 · {event.bodyKind}</p>

      <div className={`verify-card tone-${status.tone}`}>
        <strong>{status.label}</strong>
        <p>{event.verification.detail}</p>
        {event.verification.matchedKeyLabel && <p className="muted">命中密钥备注：{event.verification.matchedKeyLabel}</p>}
      </div>

      <h3>请求头（已脱敏）</h3>
      <pre>{Object.entries(event.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>

      <h3>正文（已脱敏）</h3>
      {event.bodyKind === 'json' || event.bodyKind === 'form' ? (
        <>
          <pre>{JSON.stringify(event.bodyTree, null, 2)}</pre>
          <h4>线上字节形态（重放使用）</h4>
          <pre className="wire">{event.bodyText}</pre>
        </>
      ) : (
        <pre className="wire">{event.bodyText || '(空)'}</pre>
      )}

      <h3>重放记录</h3>
      {event.replays.length === 0 ? (
        <p className="muted">还没有重放过。</p>
      ) : (
        <ul className="replay-list">
          {event.replays.map((r) => (
            <li key={r.id} className={r.ok ? 'ok' : 'fail'}>
              <span>{time(r.at)}</span>
              <span>{r.durationMs}ms</span>
              {r.statusCode !== null && <span>HTTP {r.statusCode}</span>}
              {!r.ok && <span className="field-error">{r.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
