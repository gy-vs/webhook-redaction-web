// 服务端与浏览器共用的数据结构。只放类型，不放任何运行时代码。

export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512';
export type SignatureEncoding = 'hex' | 'base64';

export type SigStatus =
  | 'not-configured' // 来源没配签名
  | 'unsigned-request' // 请求没带签名头
  | 'timestamp-out-of-range' // 时间戳缺失/无法解析/超出允许窗口
  | 'malformed-signature' // 签名字符串格式不对
  | 'mismatch' // 重新计算后对不上
  | 'valid';

export interface SecretDef {
  id: string;
  label: string;
  secret: string; // 仅服务端持有，不进任何响应
}

export interface SecretView {
  id: string;
  label: string;
}

export interface SignerConfig {
  header: string; // 放签名的头名（大小写不敏感）
  algorithm: HashAlgorithm;
  encoding: SignatureEncoding;
  secrets: SecretDef[]; // 换密钥期间可同时挂多把
  timestampHeader: string | null;
  timestampSkewSeconds: number; // 仅在 timestampHeader 非空时生效
}

export interface SignerView {
  header: string;
  algorithm: HashAlgorithm;
  encoding: SignatureEncoding;
  secrets: SecretView[];
  timestampHeader: string | null;
  timestampSkewSeconds: number;
}

export interface SourceDef {
  name: string;
  replayTarget: string | null;
  signer: SignerConfig | null;
  createdAt: string;
}

export interface SourceView {
  name: string;
  replayTarget: string | null;
  signer: SignerView | null;
  createdAt: string;
}

/** 新增/编辑来源时的入参；secret 留空表示沿用服务端已存的值（换密钥时不用重填旧钥匙） */
export interface SecretInput {
  id: string;
  label: string;
  secret?: string;
}

export interface SignerInput {
  header: string;
  algorithm: HashAlgorithm;
  encoding: SignatureEncoding;
  secrets: SecretInput[];
  timestampHeader: string | null;
  timestampSkewSeconds: number;
}

export interface VerificationResult {
  status: SigStatus;
  header?: string;
  signatureReceived?: string; // 摘要本身不是敏感字段，原样展示便于排查
  prefix?: string; // 例如 sha256= 这种前缀
  timestamp?: string;
  matchedSecretId?: string;
  matchedSecretLabel?: string;
  note?: string;
}

export interface ReplayRecord {
  at: string;
  target: string;
  status: number | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
}

export type BodyKind = 'json' | 'form' | 'multipart' | 'text' | 'empty';

export interface EventRecord {
  id: number;
  source: string;
  receivedAt: string;
  method: string;
  path: string; // 含 query 的完整原始路径
  headers: Record<string, string>; // 已按规则处理
  contentType: string | null;
  bodyKind: BodyKind;
  body: unknown; // json/form/multipart 的结构化表示（已处理）
  rawText: string | null; // text/empty 的文本表示
  verification: VerificationResult;
  replays: ReplayRecord[];
}

export type RuleTarget =
  | { kind: 'header'; name: string }
  | { kind: 'jsonPath'; path: string };

export type RuleAction =
  | { type: 'remove' }
  | { type: 'replace'; text: string }
  | { type: 'last'; keep: number; mask: string };

export interface RedactionRule {
  id: string;
  name: string;
  enabled: boolean;
  target: RuleTarget;
  action: RuleAction;
}

export interface ReplayResult {
  id: number;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export interface PreviewResponse {
  contentType: string | null;
  bodyKind: BodyKind;
  body: unknown;
  rawText: string | null;
  headers: Record<string, string>;
}
