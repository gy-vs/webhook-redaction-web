import {createHmac, timingSafeEqual} from 'node:crypto';
import type {HmacAlgorithm, SignatureConfig, VerificationResult} from '../shared/types';

const NODE_ALGORITHM: Record<HmacAlgorithm, 'sha1' | 'sha256' | 'sha512'> = {
  sha1: 'sha1',
  sha256: 'sha256',
  sha512: 'sha512',
};

/** Accept "sha256=abc...", "v1=..." etc. but only by stripping a prefix. */
function extractSignature(raw: string): string {
  const eq = raw.indexOf('=');
  // A prefix is only tolerated when the part after '=' is the whole digest;
  // base64 may contain '=' padding, so require the prefix to be a short token.
  if (eq > 0 && eq <= 16 && !raw.slice(0, eq).includes(' ')) {
    return raw.slice(eq + 1).trim();
  }
  return raw.trim();
}

function decodeDigest(text: string, encoding: SignatureConfig['encoding']): Buffer | null {
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) return null;
    return Buffer.from(text, 'hex');
  }
  // Standard base64 or base64url, with the usual length/alphabet check.
  if (!/^[A-Za-z0-9+/_=-]+$/.test(text)) return null;
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(standard, 'base64');
  if (buf.length === 0) return null;
  // Round-trip comparison rejects truncated/garbled base64.
  if (buf.toString('base64').replace(/=+$/, '') !== standard.replace(/=+$/, '')) {
    return null;
  }
  return buf;
}

function sameLengthEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify against the EXACT bytes the remote signed. Parsing/re-encoding the
 * body (even a reordering of JSON keys or \u escapes) never happens here.
 */
export function verifySignature(
  config: SignatureConfig | null,
  headers: Record<string, string>,
  rawBody: Buffer,
  now: number = Date.now(),
): VerificationResult {
  if (!config) return {status: 'not_configured', detail: 'This source has no signature configuration.'};

  const getHeader = (name: string) => {
    const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit ? hit[1] : undefined;
  };

  const rawSignature = getHeader(config.header);
  if (rawSignature === undefined || rawSignature === '') {
    return {status: 'missing_signature', detail: `Request did not carry header ${config.header}.`};
  }

  let timestamp: string | null = null;
  if (config.timestampHeader) {
    const rawTs = getHeader(config.timestampHeader);
    if (rawTs === undefined || rawTs === '') {
      return {status: 'timestamp_invalid', detail: `Timestamp header ${config.timestampHeader} is absent.`};
    }
    // Support both epoch seconds and epoch milliseconds.
    const num = /^[0-9]+$/.test(rawTs.trim()) ? Number(rawTs.trim()) : NaN;
    if (Number.isNaN(num)) {
      return {status: 'timestamp_invalid', detail: `Value of ${config.timestampHeader} is not an epoch number.`};
    }
    const tsMs = rawTs.trim().length <= 10 ? num * 1000 : num;
    const skew = Math.abs(now - tsMs) / 1000;
    if (skew > config.toleranceSeconds) {
      return {
        status: 'timestamp_skew',
        detail: `Timestamp is ${Math.round(skew)}s away; tolerance is ${config.toleranceSeconds}s.`,
      };
    }
    timestamp = rawTs.trim();
  }

  const received = decodeDigest(extractSignature(rawSignature), config.encoding);
  if (!received) {
    return {status: 'malformed_signature', detail: `Signature is not valid ${config.encoding}.`};
  }

  for (const key of config.keys) {
    const hmac = createHmac(NODE_ALGORITHM[config.algorithm], key.secret);
    if (config.signedContent === 'timestampDotRawBody' && timestamp !== null) {
      hmac.update(timestamp).update('.');
    }
    hmac.update(rawBody);
    const expected = hmac.digest();
    if (sameLengthEqual(received, expected)) {
      return {
        status: 'valid',
        detail: 'HMAC matches the raw request bytes.',
        matchedKeyLabel: key.label || undefined,
      };
    }
  }

  return {status: 'mismatch', detail: 'HMAC of the raw request bytes matches none of the configured keys.'};
}
