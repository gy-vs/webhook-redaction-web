import {useMemo, useState, type Dispatch, type SetStateAction} from 'react';
import {Plus, Trash2} from 'lucide-react';
import type {
  HmacAlgorithm,
  RedactionRule,
  RuleAction,
  SignatureEncoding,
  SignatureKey,
  Source,
  SourceView,
} from '../shared/types';
import {api} from './api';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function blankSource(name: string): Source {
  return {
    name,
    targetUrl: '',
    signature: null,
    rules: [],
    createdAt: Date.now(),
  };
}

interface DraftSource extends Omit<Source, 'signature'> {
  signature: Source['signature'] | null;
}

export function SourceEditor({
  sources,
  edited,
  onClose,
  onSaved,
}: {
  sources: SourceView[];
  edited: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = sources.find((s) => s.name === edited);
  const [draft, setDraft] = useState<DraftSource>(() => {
    if (existing) {
      // Views carry no secrets; empty secret fields preserve stored secrets.
      return {
        ...existing,
        signature: existing.signature
          ? {...existing.signature, keys: existing.signature.keys.map((k) => ({id: k.id, label: k.label ?? '', secret: ''}))}
          : null,
      };
    }
    return blankSource(edited ?? '');
  });
  const [errors, setErrors] = useState<{field: string; message: string; pathErrorAt?: number}[]>([]);
  const [saving, setSaving] = useState(false);

  const sig = draft.signature;
  const update = (patch: Partial<DraftSource>) => setDraft((d) => ({...d, ...patch}));
  const updateSig = (patch: Partial<NonNullable<DraftSource['signature']>>) =>
    setDraft((d) => ({...d, signature: d.signature ? {...d.signature, ...patch} : d.signature}));

  async function save() {
    setSaving(true);
    setErrors([]);
    try {
      await api.saveSource(draft as Source);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof Error && 'body' in err) {
        const body = (err as {body: {errors?: typeof errors; error?: string}}).body;
        setErrors(body.errors ?? [{field: '_', message: body.error ?? err.message}]);
      } else {
        setErrors([{field: '_', message: String(err)}]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{existing ? `编辑来源：${existing.name}` : '新来源'}</h2>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>

        <div className="form-grid">
          <label>
            来源名（对方打到 <code>/hook/名称/…</code>）
            <input
              value={draft.name}
              disabled={Boolean(existing)}
              onChange={(e) => update({name: e.target.value})}
              placeholder="acme-pay"
            />
          </label>
          <label>
            本地重放目标地址（留空则禁止重放）
            <input
              value={draft.targetUrl}
              onChange={(e) => update({targetUrl: e.target.value})}
              placeholder="http://127.0.0.1:8080/inbound"
            />
          </label>
        </div>

        <section className="block">
          <div className="block-head">
            <h3>签名校验</h3>
            <button
              className="ghost"
              onClick={() =>
                update({
                  signature: sig
                    ? null
                    : {
                        header: 'X-Signature',
                        timestampHeader: '',
                        toleranceSeconds: 300,
                        algorithm: 'sha256',
                        encoding: 'hex',
                        signedContent: 'rawBody',
                        keys: [{id: uid(), secret: '', label: 'new'}],
                      },
                })
              }
            >
              {sig ? '停用签名' : '配置签名'}
            </button>
          </div>

          {sig && (
            <div className="form-grid">
              <label>
                签名头名
                <input value={sig.header} onChange={(e) => updateSig({header: e.target.value})} />
              </label>
              <label>
                算法
                <select
                  value={sig.algorithm}
                  onChange={(e) => updateSig({algorithm: e.target.value as HmacAlgorithm})}
                >
                  <option value="sha256">HMAC-SHA256</option>
                  <option value="sha1">HMAC-SHA1</option>
                  <option value="sha512">HMAC-SHA512</option>
                </select>
              </label>
              <label>
                签名编码
                <select
                  value={sig.encoding}
                  onChange={(e) => updateSig({encoding: e.target.value as SignatureEncoding})}
                >
                  <option value="hex">hex</option>
                  <option value="base64">base64</option>
                </select>
              </label>
              <label>
                签名内容
                <select
                  value={sig.signedContent}
                  onChange={(e) =>
                    updateSig({
                      signedContent: e.target.value as NonNullable<DraftSource['signature']>['signedContent'],
                    })
                  }
                >
                  <option value="rawBody">原始请求正文</option>
                  <option value="timestampDotRawBody">时间戳 + "." + 原始正文</option>
                </select>
              </label>
              <label>
                时间戳头名（留空 = 不检查时间窗口）
                <input
                  value={sig.timestampHeader ?? ''}
                  onChange={(e) => updateSig({timestampHeader: e.target.value})}
                  placeholder="X-Timestamp"
                />
              </label>
              <label>
                允许时间偏差（秒）
                <input
                  type="number"
                  min={0}
                  value={sig.toleranceSeconds}
                  onChange={(e) => updateSig({toleranceSeconds: Number(e.target.value)})}
                />
              </label>

              <div className="keys">
                <div className="block-head"><h4>密钥（换钥期间可多把，先到先认）</h4></div>
                {sig.keys.map((key, i) => (
                  <KeyRow
                    key={key.id}
                    keyRow={key}
                    isExisting={Boolean(existing?.signature?.keys.some((k) => k.id === key.id))}
                    onChange={(next) =>
                      updateSig({keys: sig.keys.map((k) => (k.id === key.id ? next : k))})
                    }
                    onRemove={() => updateSig({keys: sig.keys.filter((k) => k.id !== key.id)})}
                    canRemove={sig.keys.length > 1 || i > 0}
                  />
                ))}
                <button
                  className="ghost"
                  onClick={() => updateSig({keys: [...sig.keys, {id: uid(), secret: '', label: ''}]})}
                >
                  <Plus size={14}/> 再加一把密钥
                </button>
              </div>
            </div>
          )}
        </section>

        <RuleEditor draft={draft} setDraft={setDraft} errorFor={errorFor} />

        {errors.length > 0 && (
          <ul className="error-list">
            {errors.map((e, i) => (
              <li key={i}><code>{e.field}</code>：{e.message}</li>
            ))}
          </ul>
        )}

        <div className="modal-foot">
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存来源'}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  keyRow,
  isExisting,
  onChange,
  onRemove,
  canRemove,
}: {
  keyRow: SignatureKey;
  isExisting: boolean;
  onChange: (next: SignatureKey) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="key-row">
      <input
        placeholder={isExisting ? '留空 = 沿用已保存的密钥' : '密钥'}
        value={keyRow.secret}
        type="password"
        onChange={(e) => onChange({...keyRow, secret: e.target.value})}
      />
      <input
        placeholder="备注（如 new / old）"
        value={keyRow.label ?? ''}
        onChange={(e) => onChange({...keyRow, label: e.target.value})}
      />
      <button className="ghost icon-btn" disabled={!canRemove} onClick={onRemove} title="删除密钥">
        <Trash2 size={15}/>
      </button>
    </div>
  );
}

// ---- Rules + live preview --------------------------------------------

export function RuleEditor({
  draft,
  setDraft,
  errorFor,
}: {
  draft: DraftSource;
  setDraft: Dispatch<SetStateAction<DraftSource>>;
  errorFor: (field: string) => {message: string; pathErrorAt?: number} | undefined;
}) {
  const [sampleHeaders, setSampleHeaders] = useState('content-type: application/json');
  const [sampleBody, setSampleBody] = useState(
    JSON.stringify({card: {number: '4111111111111111'}, phone: '13800001234', note: 'ok'}, null, 2),
  );
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.preview>> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pathChecks, setPathChecks] = useState<Record<string, {valid: boolean; offset?: number; message?: string}>>({});

  const addRule = () => {
    const rule: RedactionRule = {id: uid(), scope: 'body', target: '', action: 'replace', replacement: '[REDACTED]'};
    setDraft((d) => ({...d, rules: [...d.rules, rule]}));
  };
  const updateRule = (id: string, patch: Partial<RedactionRule>) =>
    setDraft((d) => ({...d, rules: d.rules.map((r) => (r.id === id ? {...r, ...patch} : r))}));
  const removeRule = (id: string) => setDraft((d) => ({...d, rules: d.rules.filter((r) => r.id !== id)}));

  const headerMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const line of sampleHeaders.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return map;
  }, [sampleHeaders]);

  async function runPreview() {
    setPreviewError(null);
    try {
      const result = await api.preview({headers: headerMap, body: sampleBody, rules: draft.rules});
      setPreview(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    }
  }

  async function checkPath(ruleId: string, target: string) {
    if (!target) return;
    const result = await api.checkPath(target);
    setPathChecks((m) => ({...m, [ruleId]: result.valid ? {valid: true} : {valid: false, offset: result.errorAt, message: result.message}}));
  }

  return (
    <section className="block">
      <div className="block-head">
        <h3>脱敏规则</h3>
        <button className="ghost" onClick={addRule}><Plus size={14}/> 新增规则</button>
      </div>

      <div className="rules">
        {draft.rules.map((rule, i) => {
          const err = errorFor(`rules[${i}].target`);
          const liveCheck = pathChecks[rule.id];
          const shownError = err ?? (liveCheck && !liveCheck.valid ? {message: liveCheck.message ?? '', pathErrorAt: liveCheck.offset} : undefined);
          return (
            <div className="rule-row" key={rule.id}>
              <select value={rule.scope} onChange={(e) => updateRule(rule.id, {scope: e.target.value as RedactionRule['scope']})}>
                <option value="header">请求头</option>
                <option value="body">JSON 路径</option>
              </select>
              <div className="target-cell">
                <input
                  className={shownError ? 'invalid' : ''}
                  placeholder={rule.scope === 'header' ? '头名，如 authorization' : "如 card.number 或 items[0][\"a.b\"]"}
                  value={rule.target}
                  onChange={(e) => {
                    updateRule(rule.id, {target: e.target.value});
                    if (rule.scope === 'body') {
                      setPathChecks((m) => ({...m, [rule.id]: {valid: true}}));
                    }
                  }}
                  onBlur={() => rule.scope === 'body' && checkPath(rule.id, rule.target)}
                />
                {shownError && <small className="field-error">第 {((shownError.pathErrorAt ?? 0) + 1)} 个字符：{shownError.message}</small>}
              </div>
              <select value={rule.action} onChange={(e) => updateRule(rule.id, {action: e.target.value as RuleAction})}>
                <option value="drop">整项删除</option>
                <option value="replace">替换为固定文本</option>
                <option value="tail">只留末尾几位</option>
              </select>
              {rule.action === 'replace' && (
                <input
                  className="arg"
                  value={rule.replacement ?? ''}
                  onChange={(e) => updateRule(rule.id, {replacement: e.target.value})}
                  placeholder="替换文本"
                />
              )}
              {rule.action === 'tail' && (
                <input
                  className="arg"
                  type="number"
                  min={1}
                  value={rule.keepLast ?? 4}
                  onChange={(e) => updateRule(rule.id, {keepLast: Number(e.target.value)})}
                  title="保留字符数"
                />
              )}
              <button className="ghost icon-btn" onClick={() => removeRule(rule.id)} title="删除规则"><Trash2 size={15}/></button>
            </div>
          );
        })}
        {draft.rules.length === 0 && <p className="muted">还没有规则。卡号、手机号、token 都建议在这里处理掉。</p>}
      </div>

      <div className="preview">
        <h4>样例试运行</h4>
        <div className="preview-inputs">
          <textarea
            spellCheck={false}
            value={sampleHeaders}
            onChange={(e) => setSampleHeaders(e.target.value)}
            placeholder={'一行一个请求头\ncontent-type: application/json'}
          />
          <textarea
            spellCheck={false}
            value={sampleBody}
            onChange={(e) => setSampleBody(e.target.value)}
            placeholder="粘贴一个完整的请求正文"
          />
        </div>
        <button className="ghost" onClick={runPreview}>运行脱敏对比</button>
        {previewError && <p className="field-error">{previewError}</p>}
        {preview && (
          <div className="preview-result">
            <div>
              <h5>处理前（原始字节，仅出现在此对比框）</h5>
              <pre>{preview.beforeText}</pre>
              <h5>请求头</h5>
              <pre>{JSON.stringify(preview.headers, null, 2)}</pre>
            </div>
            <div>
              <h5>处理后（落库 / 响应 / 推送 / 重放的内容）</h5>
              <pre>{preview.afterText}</pre>
              {preview.bodyKind === 'json' && (
                <>
                  <h5>解析树对比</h5>
                  <div className="tree-pair">
                    <pre>{JSON.stringify(preview.beforeTree, null, 2)}</pre>
                    <pre>{JSON.stringify(preview.afterTree, null, 2)}</pre>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
