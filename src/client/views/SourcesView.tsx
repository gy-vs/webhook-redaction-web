import {useEffect, useState} from 'react';
import {Trash2, Plus, Save, KeyRound} from 'lucide-react';
import type {HashAlgorithm, SignatureEncoding, SignerInput, SourceView} from '../../shared/types';
import {api} from '../api';

interface SecretRow { id: string; label: string; secret: string }
interface Draft {
  name: string;
  replayTarget: string;
  signEnabled: boolean;
  header: string;
  algorithm: HashAlgorithm;
  encoding: SignatureEncoding;
  timestampHeader: string;
  skew: number;
  secrets: SecretRow[];
}

const emptyDraft: Draft = {
  name: '',
  replayTarget: '',
  signEnabled: false,
  header: 'x-signature',
  algorithm: 'sha256',
  encoding: 'hex',
  timestampHeader: '',
  skew: 300,
  secrets: [{ id: cryptoId(), label: 'new', secret: '' }],
};

function cryptoId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function SourcesView({onError, onSaved}: { onError: (m: string) => void; onSaved: (m: string) => void }) {
  const [sources, setSources] = useState<SourceView[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.listSources().then(setSources).catch(e => onError(String(e.message ?? e)));
  useEffect(() => { refresh(); }, []);

  function loadEdit(s: SourceView) {
    setEditing(s.name);
    setDraft({
      name: s.name,
      replayTarget: s.replayTarget ?? '',
      signEnabled: s.signer !== null,
      header: s.signer?.header ?? 'x-signature',
      algorithm: s.signer?.algorithm ?? 'sha256',
      encoding: s.signer?.encoding ?? 'hex',
      timestampHeader: s.signer?.timestampHeader ?? '',
      skew: s.signer?.timestampSkewSeconds ?? 300,
      secrets: (s.signer?.secrets ?? []).map(x => ({ id: x.id, label: x.label, secret: '' })),
    });
  }

  function reset() {
    setEditing(null);
    setDraft(emptyDraft);
  }

  async function save() {
    if (!/^[\w一-鿿-]+$/.test(draft.name)) { onError('来源名只能含字母、数字、下划线、连字符和中文'); return; }
    setBusy(true);
    try {
      const body = {
        replayTarget: draft.replayTarget,
        signer: draft.signEnabled
          ? {
              header: draft.header,
              algorithm: draft.algorithm,
              encoding: draft.encoding,
              timestampHeader: draft.timestampHeader.trim() || null,
              timestampSkewSeconds: draft.skew,
              secrets: draft.secrets.map(s => ({ id: s.id, label: s.label, secret: s.secret })),
            } satisfies SignerInput
          : null,
      };
      const view = await api.putSource(draft.name, body);
      onSaved(`来源「${view.name}」已保存，回调地址 /hook/${view.name}/<任意路径>`);
      reset();
      refresh();
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: SourceView) {
    if (!confirm(`删除来源「${s.name}」？已有事件保留，但无法再接收该来源的回调。`)) return;
    try {
      await api.deleteSource(s.name);
      if (editing === s.name) reset();
      refresh();
    } catch (e: any) { onError(String(e?.message ?? e)); }
  }

  const setSec = (id: string, patch: Partial<SecretRow>) =>
    setDraft(d => ({ ...d, secrets: d.secrets.map(s => (s.id === id ? { ...s, ...patch } : s)) }));

  return (
    <section className="workspace wide">
      <aside className="pane">
        <h2>已登记来源</h2>
        <div className="list">
          {sources.length === 0 && <p className="muted">还没有来源，用右侧表单登记一个。</p>}
          {sources.map(s => (
            <div key={s.name} className={`source-card ${editing === s.name ? 'active' : ''}`}>
              <button className="source-main" onClick={() => loadEdit(s)}>
                <b>{s.name}</b>
                <small>{s.signer ? `HMAC-${s.signer.algorithm} · ${s.signer.secrets.length} 把密钥` : '不验签'}</small>
                <small className="target">{s.replayTarget ?? '未配置重放目标'}</small>
              </button>
              <button className="icon-btn" title="删除来源" onClick={() => remove(s)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      </aside>

      <section className="pane form-pane">
        <h2>{editing ? `编辑来源「${editing}」` : '登记新来源'}</h2>
        <div className="form-grid">
          <label>来源名
            <input value={draft.name} disabled={editing !== null} placeholder="如 stripe-cn"
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
          </label>
          <label>本地重放目标地址
            <input value={draft.replayTarget} placeholder="http://127.0.0.1:8080/callback"
              onChange={e => setDraft(d => ({ ...d, replayTarget: e.target.value }))} />
          </label>

          <label className="checkline">
            <input type="checkbox" checked={draft.signEnabled} onChange={e => setDraft(d => ({ ...d, signEnabled: e.target.checked }))} />
            <KeyRound size={15} /> 启用 HMAC 签名校验
          </label>

          {draft.signEnabled && (
            <div className="signer-box">
              <div className="form-grid two">
                <label>签名所在头名
                  <input value={draft.header} onChange={e => setDraft(d => ({ ...d, header: e.target.value }))} />
                </label>
                <label>算法
                  <select value={draft.algorithm} onChange={e => setDraft(d => ({ ...d, algorithm: e.target.value as HashAlgorithm }))}>
                    <option value="sha256">HMAC-SHA256</option>
                    <option value="sha1">HMAC-SHA1</option>
                    <option value="sha512">HMAC-SHA512</option>
                  </select>
                </label>
                <label>签名编码
                  <select value={draft.encoding} onChange={e => setDraft(d => ({ ...d, encoding: e.target.value as SignatureEncoding }))}>
                    <option value="hex">hex</option>
                    <option value="base64">base64</option>
                  </select>
                </label>
                <label>时间戳头名（留空 = 不校验时间）
                  <input value={draft.timestampHeader} placeholder="x-timestamp"
                    onChange={e => setDraft(d => ({ ...d, timestampHeader: e.target.value }))} />
                </label>
                <label>允许时间偏差（秒）
                  <input type="number" min={0} value={draft.skew}
                    onChange={e => setDraft(d => ({ ...d, skew: Number(e.target.value) }))} />
                </label>
              </div>

              <div className="secrets">
                <div className="row-between"><h3>密钥（换密钥期间新旧都填，都会被认可）</h3></div>
                {draft.secrets.map(s => {
                  const existing = editing && !s.secret;
                  return (
                    <div key={s.id} className="secret-row">
                      <input className="label" placeholder="标签 old/new" value={s.label} onChange={e => setSec(s.id, { label: e.target.value })} />
                      <input className="secret" type="password" placeholder={existing ? '已保存，留空表示不改' : '密钥内容'}
                        value={s.secret} onChange={e => setSec(s.id, { secret: e.target.value })} />
                      <button className="icon-btn" title="移除这把密钥"
                        onClick={() => setDraft(d => ({ ...d, secrets: d.secrets.filter(x => x.id !== s.id) }))}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
                <button className="btn" onClick={() => setDraft(d => ({ ...d, secrets: [...d.secrets, { id: cryptoId(), label: '', secret: '' }] }))}>
                  <Plus size={14} /> 再加一把密钥
                </button>
                <p className="hint">密钥只保存在服务端本机文件里，任何接口都不会回显。</p>
              </div>
            </div>
          )}
        </div>

        <div className="form-actions">
          <button className="btn primary" disabled={busy} onClick={save}><Save size={15} /> {editing ? '保存修改' : '登记来源'}</button>
          {editing && <button className="btn" onClick={reset}>取消编辑</button>}
        </div>
      </section>
    </section>
  );
}
