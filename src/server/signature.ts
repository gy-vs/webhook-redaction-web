import crypto from 'node:crypto';
import type {
  HashAlgorithm, SignatureEncoding, SignerConfig, VerificationResult,
} from '../shared/types.js';

/** 对字节敏感：直接验对方发过来的原始 Buffer，不做任何解析/重序列化。 */
export function verifySignature(
  rawBody: Buffer,
  headers: Record<string, string>,
  signer: SignerConfig | null,
  now: number = Date.now(),
): VerificationResult {
  if (!signer) return { status: 'not-configured' };

  const headerValue = getHeader(headers, signer.header);
  if (headerValue === undefined || headerValue === '') {
    return { status: 'unsigned-request', header: signer.header };
  }

  let timestamp: string | undefined;
  if (signer.timestampHeader) {
    timestamp = getHeader(headers, signer.timestampHeader);
    if (timestamp === undefined || timestamp === '') {
      return {
        status: 'timestamp-out-of-range',
        header: signer.header,
        signatureReceived: headerValue,
        timestamp: timestamp ?? '',
        note: `时间戳头 ${signer.timestampHeader} 缺失`,
      };
    }
    const ms = parseTimestamp(timestamp);
    if (ms === null) {
      return {
        status: 'timestamp-out-of-range',
        header: signer.header,
        signatureReceived: headerValue,
        timestamp,
        note: `时间戳 ${timestamp} 无法解析（支持 Unix 秒或毫秒）`,
      };
    }
    const skew = Math.abs(now - ms);
    if (skew > signer.timestampSkewSeconds * 1000) {
      return {
        status: 'timestamp-out-of-range',
        header: signer.header,
        signatureReceived: headerValue,
        timestamp,
        note: `时间偏差 ${Math.round(skew / 1000)}s，超过允许的 ${signer.timestampSkewSeconds}s`,
      };
    }
  }

  // 允许形如 "sha256=xxxx" 的前缀（如 Stripe 风格），前缀内容不参与比较
  let prefix = '';
  let digest = headerValue.trim();
  const eq = digest.indexOf('=');
  if (eq !== -1 && /^[A-Za-z0-9-]+$/.test(digest.slice(0, eq))) {
    prefix = digest.slice(0, eq + 1);
    digest = digest.slice(eq + 1).trim();
  }

  if (!isWellFormedDigest(digest, signer.encoding)) {
    return {
      status: 'malformed-signature',
      header: signer.header,
      signatureReceived: headerValue,
      prefix: prefix || undefined,
      timestamp,
      note: `签名不是合法的 ${signer.encoding} 串`,
    };
  }

  for (const secret of signer.secrets) {
    const expected = hmac(signer.algorithm, secret.secret, rawBody, signer.encoding);
    if (safeEqual(expected, digest, signer.encoding)) {
      return {
        status: 'valid',
        header: signer.header,
        signatureReceived: headerValue,
        prefix: prefix || undefined,
        timestamp,
        matchedSecretId: secret.id,
        matchedSecretLabel: secret.label,
      };
    }
  }

  return {
    status: 'mismatch',
    header: signer.header,
    signatureReceived: headerValue,
    prefix: prefix || undefined,
    timestamp,
    note: `用 ${signer.secrets.length} 把已登记密钥重算均不匹配`,
  };
}

function hmac(alg: HashAlgorithm, secret: string, body: Buffer, enc: SignatureEncoding): string {
  return crypto.createHmac(alg, secret).update(body).digest(enc === 'base64' ? 'base64' : 'hex');
}

/** 常量时间比较；hex 串常见大小写差异故忽略大小写（仅 A-F），base64 区分大小写。 */
function safeEqual(a: string, b: string, enc: SignatureEncoding): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const fold = (c: number) => (enc === 'hex' && c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    diff |= fold(a.charCodeAt(i)) ^ fold(b.charCodeAt(i));
  }
  return diff === 0;
}

function isWellFormedDigest(s: string, enc: SignatureEncoding): boolean {
  if (s.length === 0) return false;
  const re = enc === 'hex' ? /^[0-9a-fA-F]+$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!re.test(s)) return false;
  if (enc === 'hex' && s.length % 2 !== 0) return false;
  if (enc === 'base64' && s.replace(/=+$/, '').length === 0) return false;
  return true;
}

/** 支持纯数字 Unix 秒（10 位）与毫秒（13 位），也支持 ISO 8601。 */
function parseTimestamp(raw: string): number | null {
  const t = raw.trim();
  if (/^[0-9]+$/.test(t)) {
    const n = Number(t);
    return t.length <= 10 ? n * 1000 : n;
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
