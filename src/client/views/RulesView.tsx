import {useEffect, useState} from 'react';
import {Save, Plus, Trash2, Play, AlertTriangle} from 'lucide-react';
import type {RedactionRule, RuleAction} from '../../shared/types';
import {api, type PreviewResult} from '../api';

function rid() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function newRule(): RedactionRule {
  return {
    id: rid(),
    name: '',
    enabled: true,
    target: { kind: 'jsonPath', path: '$.' },
    action: { type: 'remove' },
  };
}

type ErrorMap = Record<string, { message: string; column?: number }>;

export default function RulesView({onError, onSaved}: { onError: (m: string) => void; onSaved: (m: string) => void }) {
  const [rules, setRules] = useState<RedactionRule[]>([]);
  const [errors, setErrors] = useState<ErrorMap>({});
  const [busy, setBusy] = useState(false);

  // 样例区
  const [sampleCt, setSampleCt] = useState('application/json');
  const [sampleHeaders, setSampleHeaders] = useState('Authorization: Bearer eyJ.raw.token\nX-Phone: 13812345678');
  const [sampleBody, setSampleBody] = useState(JSON.stringify({
    user: { name: '张三', phone: '13812345678', card: '6222021234567890123' },
    token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
    items: [{ name: 'a' }],
  }, null, 2));
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  useEffect(() => { api.listRules().then(setRules).catch(e => onError(String(e.message ?? e))); }, []);

  const patch = (id: string, p: Partial<RedactionRule>) =>
    setRules(rs => rs.map(r => (r.id === id ? { ...r, ...p } : r)));
  const patchTarget = (id: string, p: Record<string, unknown>) =>
    setRules(rs => rs.map(r => (r.id === id ? { ...r, target: { ...r.target, ...p } as RedactionRule['target'] } : r)));
  const patchAction = (id: string, p: Partial<RuleAction>) =>
    setRules(rs => rs.map(r => (r.id === id ? { ...r, action: { ...r.action, ...p } as RuleAction } : r)));

  async function save() {
    setBusy(true);
    try {
      const saved = await api.putRules(rules);
      setRules(saved);
      setErrors({});
      onSaved(`已保存 ${saved.length} 条规则`);
    } catch (e: any) {
      onError(String(e?.message ?? e));
      // 服务端返回的结构化错误里带字符位置
      tryRefreshErrors();
    } finally {
      setBusy(false);
    }
  }

  async function tryRefreshErrors() {
    try {
      const p = await runPreviewRequest(rules);
      const map: ErrorMap = {};
      for (const er of p.errors) map[er.ruleId] = { message: er.message, column: er.column };
      setErrors(map);
    } catch { /* 保存报错本身已提示 */ }
  }

  async function runPreviewRequest(ruleList: RedactionRule[]): Promise<PreviewResult> {
    const headerPairs = sampleHeaders.split('\n').map(line => {
      const i = line.indexOf(':');
      return i === -1 ? null : { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    }).filter(Boolean);
    return api.preview({
      contentType: sampleCt.trim() || null,
      rawText: sampleBody,
      headerPairs,
      rules: ruleList,
    });
  }

  async function doPreview() {
    try {
      const p = await runPreviewRequest(rules);
      setPreview(p);
      const map: ErrorMap = {};
      for (const er of p.errors) map[er.ruleId] = { message: er.message, column: er.column };
      setErrors(map);
    } catch (e: any) {
      onError(String(e?.message ?? e));
    }
  }

  return (
    <section className="rules-layout">
      <div className="pane rules-pane">
        <div className="pane-head">
          <h2>脱敏规则（按顺序执行）</h2>
          <div>
            <button className="btn" onClick={() => setRules(rs => [...rs, newRule()])}><Plus size={14} /> 新建规则</button>
            <button className="btn primary" disabled={busy} onClick={save}><Save size={14} /> 保存全部</button>
          </div>
        </div>

        <div className="rule-list">
          {rules.length === 0 && <p className="muted">还没有规则。规则会同时作用于新回调的存储/推送/响应，以及旧事件的重放。</p>}
          {rules.map((r, idx) => {
            const err = errors[r.id];
            return (
              <div key={r.id} className={`rule-card ${!r.enabled ? 'off' : ''}`}>
                <div className="rule-head">
                  <input type="checkbox" checked={r.enabled} onChange={e => patch(r.id, { enabled: e.target.checked })} title="启用/停用" />
                  <span className="order">#{idx + 1}</span>
                  <input className="rule-name" placeholder="规则名，如 手机号" value={r.name} onChange={e => patch(r.id, { name: e.target.value })} />
                  <button className="icon-btn" onClick={() => setRules(rs => rs.filter(x => x.id !== r.id))}><Trash2 size={15} /></button>
                </div>

                <div className="rule-row">
                  <label>作用对象
                    <select value={r.target.kind}
                      onChange={e => patch(r.id, { target: e.target.value === 'header'
                        ? { kind: 'header', name: '' } : { kind: 'jsonPath', path: '$.' } })}>
                      <option value="jsonPath">JSON 路径</option>
                      <option value="header">请求头名</option>
                    </select>
                  </label>
                  {r.target.kind === 'header' ? (
                    <label className="grow">头名（大小写不敏感）
                      <input value={r.target.name} placeholder="authorization" onChange={e => patchTarget(r.id, { name: e.target.value })} />
                    </label>
                  ) : (
                    <label className="grow">路径（支持 $.a.b、$["a.b"]、$[0]）
                      <input
                        className={err?.column ? 'path-bad' : ''}
                        value={r.target.path}
                        spellCheck={false}
                        placeholder="$.user.phone"
                        onChange={e => patchTarget(r.id, { path: e.target.value })}
                      />
                    </label>
                  )}
                </div>

                <div className="rule-row">
                  <label>处理方式
                    <select value={r.action.type} onChange={e => {
                      const t = e.target.value as RuleAction['type'];
                      patch(r.id, {
                        action: t === 'remove' ? { type: 'remove' }
                          : t === 'replace' ? { type: 'replace', text: '[已脱敏]' }
                            : { type: 'last', keep: 4, mask: '*' },
                      });
                    }}>
                      <option value="remove">整项删掉</option>
                      <option value="replace">换成固定文本</option>
                      <option value="last">只留末尾几位</option>
                    </select>
                  </label>
                  {r.action.type === 'replace' && (
                    <label className="grow">固定文本
                      <input value={r.action.text} onChange={e => patchAction(r.id, { text: e.target.value })} />
                    </label>
                  )}
                  {r.action.type === 'last' && (
                    <>
                      <label>保留位数
                        <input type="number" min={1} value={r.action.keep} onChange={e => patchAction(r.id, { keep: Number(e.target.value) })} />
                      </label>
                      <label>遮盖字符
                        <input value={r.action.mask} onChange={e => patchAction(r.id, { mask: e.target.value })} />
                      </label>
                    </>
                  )}
                </div>

                {err && (
                  <div className="rule-error">
                    <AlertTriangle size={14} /> {err.message}
                    {err.column !== undefined && r.target.kind === 'jsonPath' && (
                      <span className="pointer">
                        <code>{r.target.path}</code>
                        <span className="arrow">{' '.repeat(Math.max(0, err.column - 1))}↑ 第 {err.column} 个字符</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="pane sample-pane">
        <h2>样例试跑</h2>
        <label>Content-Type
          <input value={sampleCt} onChange={e => setSampleCt(e.target.value)} />
        </label>
        <label>请求头（每行 Name: Value）
          <textarea className="small" value={sampleHeaders} onChange={e => setSampleHeaders(e.target.value)} spellCheck={false} />
        </label>
        <label>原始正文字节（你贴什么，服务端就按什么字节解析）
          <textarea value={sampleBody} onChange={e => setSampleBody(e.target.value)} spellCheck={false} />
        </label>
        <button className="btn primary" onClick={doPreview}><Play size={14} /> 按当前规则处理</button>

        {preview && (
          <div className="compare">
            <div>
              <h3>处理前</h3>
              <pre>{renderBody(preview.before.bodyKind, preview.before.body, preview.before.rawText)}</pre>
            </div>
            <div>
              <h3>处理后（这才是会被存储/推送/重放的内容）</h3>
              <pre>{renderBody(preview.after.bodyKind, preview.after.body, preview.after.rawText)}</pre>
              <h3>处理后的请求头</h3>
              <pre>{Object.entries(preview.after.headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '（无）'}</pre>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function renderBody(kind: string, body: unknown, rawText: string | null): string {
  if (kind === 'text') return rawText ?? '';
  if (kind === 'empty') return '（无正文）';
  return JSON.stringify(body, null, 2);
}
