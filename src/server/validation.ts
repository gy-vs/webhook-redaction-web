import type {RedactionRule, SignatureConfig, Source} from '../shared/types';
import {validatePath} from './redact';

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALGORITHMS = new Set(['sha1', 'sha256', 'sha512']);
const ENCODINGS = new Set(['hex', 'base64']);
const ACTIONS = new Set(['drop', 'replace', 'tail']);

export interface ValidationError {
  field: string;
  message: string;
  /** Character offset inside a body-rule target path. */
  pathErrorAt?: number;
}

export function validateSourceName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

function validateRule(rule: unknown, index: number, errors: ValidationError[]) {
  const prefix = `rules[${index}]`;
  if (!rule || typeof rule !== 'object') {
    errors.push({field: prefix, message: 'must be an object'});
    return;
  }
  const r = rule as Partial<RedactionRule>;
  if (typeof r.id !== 'string' || !r.id) errors.push({field: `${prefix}.id`, message: 'id is required'});
  if (r.scope !== 'header' && r.scope !== 'body') {
    errors.push({field: `${prefix}.scope`, message: "scope must be 'header' or 'body'"});
  }
  if (typeof r.target !== 'string' || r.target.trim() === '') {
    errors.push({field: `${prefix}.target`, message: 'target is required'});
  } else if (r.scope === 'body') {
    const check = validatePath(r.target);
    if (!check.valid) {
      errors.push({field: `${prefix}.target`, message: check.message, pathErrorAt: check.offset});
    }
  }
  if (!r.action || !ACTIONS.has(r.action)) {
    errors.push({field: `${prefix}.action`, message: "action must be 'drop', 'replace' or 'tail'"});
  }
  if (r.action === 'replace' && typeof r.replacement !== 'string') {
    errors.push({field: `${prefix}.replacement`, message: 'replacement text is required for action=replace'});
  }
  if (r.action === 'tail') {
    if (typeof r.keepLast !== 'number' || !Number.isInteger(r.keepLast) || r.keepLast <= 0) {
      errors.push({field: `${prefix}.keepLast`, message: 'keepLast must be a positive integer'});
    }
  }
}

function validateSignature(sig: unknown, errors: ValidationError[], prefix = 'signature', existing?: SignatureConfig) {
  if (sig === null || sig === undefined) return;
  if (!sig || typeof sig !== 'object') {
    errors.push({field: prefix, message: 'must be an object or null'});
    return;
  }
  const s = sig as Partial<SignatureConfig>;
  if (typeof s.header !== 'string' || !s.header.trim()) {
    errors.push({field: `${prefix}.header`, message: 'signature header name is required'});
  }
  if (s.timestampHeader !== undefined && s.timestampHeader !== '' && typeof s.timestampHeader !== 'string') {
    errors.push({field: `${prefix}.timestampHeader`, message: 'timestampHeader must be a header name or empty'});
  }
  if (typeof s.toleranceSeconds !== 'number' || s.toleranceSeconds < 0) {
    errors.push({field: `${prefix}.toleranceSeconds`, message: 'toleranceSeconds must be a non-negative number'});
  }
  if (!s.algorithm || !ALGORITHMS.has(s.algorithm)) {
    errors.push({field: `${prefix}.algorithm`, message: 'algorithm must be sha1, sha256 or sha512'});
  }
  if (!s.encoding || !ENCODINGS.has(s.encoding)) {
    errors.push({field: `${prefix}.encoding`, message: "encoding must be 'hex' or 'base64'"});
  }
  if (s.signedContent !== 'rawBody' && s.signedContent !== 'timestampDotRawBody') {
    errors.push({field: `${prefix}.signedContent`, message: 'signedContent must be rawBody or timestampDotRawBody'});
  }
  if (!Array.isArray(s.keys) || s.keys.length === 0) {
    errors.push({field: `${prefix}.keys`, message: 'at least one key is required'});
    return;
  }
  s.keys.forEach((key, i) => {
    if (!key || typeof key !== 'object' || typeof key.id !== 'string' || !key.id) {
      errors.push({field: `${prefix}.keys[${i}]`, message: 'each key needs an id'});
      return;
    }
    // Empty secret is allowed only for a key that already exists server-side;
    // it means "keep the stored secret". New keys must supply one.
    const isExisting = existing?.keys.some((k) => k.id === key.id);
    if ((typeof key.secret !== 'string' || key.secret === '') && !isExisting) {
      errors.push({field: `${prefix}.keys[${i}].secret`, message: 'secret is required for new keys'});
    }
  });
}

export function validateSourceInput(input: unknown, existing?: Source): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!input || typeof input !== 'object') {
    return [{field: '_', message: 'body must be a JSON object'}];
  }
  const source = input as Partial<Source>;
  if (!validateSourceName(source.name)) {
    errors.push({field: 'name', message: 'name must be 1-64 characters: letters, digits, "_" or "-"'});
  }
  if (typeof source.targetUrl !== 'string') {
    errors.push({field: 'targetUrl', message: 'targetUrl must be a string (empty disables replay)'});
  } else if (source.targetUrl !== '') {
    try {
      const url = new URL(source.targetUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.push({field: 'targetUrl', message: 'targetUrl must use http or https'});
      }
    } catch {
      errors.push({field: 'targetUrl', message: 'targetUrl is not a valid URL'});
    }
  }
  validateSignature(source.signature, errors, 'signature', existing?.signature ?? undefined);
  if (!Array.isArray(source.rules)) {
    errors.push({field: 'rules', message: 'rules must be an array'});
  } else {
    source.rules.forEach((rule, i) => validateRule(rule, i, errors));
  }
  return errors;
}
