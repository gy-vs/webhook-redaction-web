import type {SigStatus} from '../../shared/types';

const META: Record<SigStatus, { text: string; cls: string; title: string }> = {
  'not-configured': { text: '未配置签名', cls: 'sig-none', title: '该来源没有配置签名校验' },
  'unsigned-request': { text: '请求未带签名', cls: 'sig-warn', title: '签名头缺失或为空' },
  'timestamp-out-of-range': { text: '时间戳超出窗口', cls: 'sig-warn', title: '时间戳头缺失、无法解析或偏差过大' },
  'malformed-signature': { text: '签名格式不对', cls: 'sig-warn', title: '签名值不是合法的 hex/base64' },
  mismatch: { text: '签名对不上', cls: 'sig-bad', title: '用所有已登记密钥重算均不匹配' },
  valid: { text: '验签通过', cls: 'sig-ok', title: '按原始字节验签通过' },
};

export default function SigBadge({status}: { status: SigStatus }) {
  const m = META[status] ?? { text: status, cls: 'sig-warn', title: '' };
  return <span className={`badge ${m.cls}`} title={m.title}>{m.text}</span>;
}
