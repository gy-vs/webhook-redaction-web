import {createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import type {SignatureConfig} from '../src/shared/types';
import {verifySignature} from '../src/server/signature';

const cfg = (over: Partial<SignatureConfig> = {}): SignatureConfig => ({
  header: 'X-Signature',
  timestampHeader: undefined,
  toleranceSeconds: 300,
  algorithm: 'sha256',
  encoding: 'hex',
  signedContent: 'rawBody',
  keys: [{id: 'k1', secret: 's3cret', label: 'new'}, {id: 'k2', secret: 'old-key', label: 'old'}],
  ...over,
});

const hmac = (secret: string, body: Buffer | string, prefix = '') =>
  prefix + createHmac('sha256', secret).update(body).digest('hex');

describe('verifySignature', () => {
  it('distinguishes the required statuses', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(null, {}, body).status).toBe('not_configured');
    expect(verifySignature(cfg(), {}, body).status).toBe('missing_signature');
    expect(verifySignature(cfg(), {'x-signature': 'not hex!!'}, body).status).toBe('malformed_signature');
    expect(verifySignature(cfg(), {'x-signature': hmac('wrong', body)}, body).status).toBe('mismatch');
    expect(verifySignature(cfg(), {'x-signature': hmac('s3cret', body)}, body).status).toBe('valid');
  });

  it('accepts either key during rotation and reports the matching label', () => {
    const body = Buffer.from('hello');
    const result = verifySignature(cfg(), {'x-signature': hmac('old-key', body)}, body);
    expect(result.status).toBe('valid');
    expect(result.matchedKeyLabel).toBe('old');
  });

  it('verifies the EXACT bytes: JSON reordering and \\u escapes stay valid', () => {
    // Sender signed these bytes; even though they parse to the same JSON as
    // another encoding, the bytes differ and must be used verbatim.
    const senderBytes = Buffer.from('{"name":"\\u4e2d\\u6587","b":2,"a":1}');
    const sig = hmac('s3cret', senderBytes);
    const result = verifySignature(cfg(), {'x-signature': sig}, senderBytes);
    expect(result.status).toBe('valid');

    // A single trailing space changes the digest.
    const tampered = Buffer.concat([senderBytes, Buffer.from(' ')]);
    expect(verifySignature(cfg(), {'x-signature': hmac('s3cret', senderBytes)}, tampered).status).toBe('mismatch');
  });

  it('tolerates scheme prefixes on the signature header', () => {
    const body = Buffer.from('payload');
    const result = verifySignature(cfg(), {'x-signature': `sha256=${hmac('s3cret', body)}`}, body);
    expect(result.status).toBe('valid');
  });

  it('checks the timestamp window', () => {
    const tsCfg = cfg({
      timestampHeader: 'X-Ts',
      signedContent: 'timestampDotRawBody',
      toleranceSeconds: 60,
    });
    const body = Buffer.from('payload');
    const signWith = (ts: string) =>
      createHmac('sha256', 's3cret').update(ts).update('.').update(body).digest('hex');

    const now = Math.floor(Date.now() / 1000);
    expect(verifySignature(tsCfg, {'x-signature': signWith(String(now)), 'x-ts': String(now)}, body).status).toBe('valid');
    expect(verifySignature(tsCfg, {'x-signature': 'abcd', 'x-ts': String(now - 600)}, body).status).toBe('timestamp_skew');
    expect(verifySignature(tsCfg, {'x-signature': 'abcd'}, body).status).toBe('timestamp_invalid');
    expect(verifySignature(tsCfg, {'x-signature': 'abcd', 'x-ts': 'not-a-number'}, body).status).toBe('timestamp_invalid');
  });

  it('supports base64 digests', () => {
    const body = Buffer.from('payload');
    const sig = createHmac('sha256', 's3cret').update(body).digest('base64');
    expect(verifySignature(cfg({encoding: 'base64'}), {'x-signature': sig}, body).status).toBe('valid');
  });
});
