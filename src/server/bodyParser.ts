import type { BodyKind } from '../shared/types.js';

export interface ParsedBody {
  bodyKind: BodyKind;
  body: unknown; // json/form/multipart 的结构化表示
  rawText: string | null; // text/empty 时保留文本
}

export function parseBody(raw: Buffer, contentType: string | null): ParsedBody {
  const ct = (contentType ?? '').toLowerCase();
  const base = ct.split(';')[0].trim();

  if (raw.length === 0) return { bodyKind: 'empty', body: null, rawText: null };

  if (base === 'application/json' || ct.includes('+json')) {
    try {
      return { bodyKind: 'json', body: JSON.parse(raw.toString('utf8')), rawText: null };
    } catch {
      // 对方自称 JSON 但内容不是，退化为文本，字节一个不少
      return { bodyKind: 'text', body: null, rawText: raw.toString('utf8') };
    }
  }

  if (base === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(raw.toString('utf8'));
    const obj: Record<string, string | string[]> = {};
    for (const key of new Set(params.keys())) {
      const all = params.getAll(key);
      obj[key] = all.length === 1 ? all[0]! : all;
    }
    return { bodyKind: 'form', body: obj, rawText: null };
  }

  if (base === 'multipart/form-data') {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    const b = boundary ? (boundary[1] ?? boundary[2]).trim() : null;
    if (b) {
      try {
        return { bodyKind: 'multipart', body: parseMultipart(raw, b), rawText: null };
      } catch {
        return { bodyKind: 'text', body: null, rawText: raw.toString('utf8') };
      }
    }
  }

  // 其余一律按文本处理（text/*、application/xml、未知类型……）
  return { bodyKind: 'text', body: null, rawText: raw.toString('utf8') };
}

/**
 * 极简 multipart 解析：只取普通字段；文件字段只登记元信息不存字节，
 * 避免把二进制塞进事件结构。字段重复时聚合为数组。
 */
function parseMultipart(raw: Buffer, boundary: string): Record<string, unknown> {
  const delimiter = Buffer.from('--' + boundary);
  const out: Record<string, unknown> = {};
  let start = raw.indexOf(delimiter);
  if (start === -1) throw new Error('multipart: opening delimiter missing');
  start += delimiter.length;

  while (true) {
    if (raw.slice(start, start + 2).toString() === '--') break; // 结束分隔符
    // 跳过 CRLF
    if (raw.slice(start, start + 2).toString() === '\r\n') start += 2;
    const next = raw.indexOf(delimiter, start);
    if (next === -1) throw new Error('multipart: closing delimiter missing');
    const part = raw.slice(start, next - 2); // 去掉分隔符前的 CRLF
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerBlock = part.slice(0, headerEnd).toString('latin1');
      const content = part.slice(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerBlock);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerBlock);
      const name = nameMatch ? nameMatch[1]! : null;
      if (name !== null) {
        let value: unknown;
        if (filenameMatch) {
          value = { __file: filenameMatch[1] || null, size: content.length };
        } else {
          value = content.toString('utf8');
        }
        if (name in out) {
          out[name] = Array.isArray(out[name]) ? [...(out[name] as unknown[]), value] : [out[name], value];
        } else {
          out[name] = value;
        }
      }
    }
    start = next + delimiter.length;
  }
  return out;
}
