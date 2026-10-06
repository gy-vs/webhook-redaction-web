// A deliberately small JSON-pointer-style path language. No third-party
// JSONPath package: we need precise error offsets and a deliberately
// narrower grammar.
//
// Grammar:
//   path       := segment ('.' segment)*
//   segment    := name | bracket
//   name       := identifier-start identifier-part*
//                 (bare keys: letters, digits, underscore; must not start
//                  with a digit)
//   bracket    := '[' (number | quoted) ']'
//   number     := '0' | [1-9][0-9]*          // array index
//   quoted     := singleQuoted | doubleQuoted
//   singleQuoted := "'" (escape | [^'\\])* "'"
//   doubleQuoted := '"' (escape | [^"\\])* '"'
//   escape     := '\\' ( '"' | "'" | '\\' | '/' | 'b' | 'f'
//                       | 'n' | 'r' | 't' | 'u' HEX{4} )
//
// Examples:
//   payment.card.number
//   payload.items[0].amount
//   user["weird.key"][3]
//   form['it\'s ok']

export type PathToken =
  | {kind: 'key'; key: string}
  | {kind: 'index'; index: number};

export class PathParseError extends Error {
  /** Zero-based character offset the parser rejects. */
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at character ${offset + 1})`);
    this.offset = offset;
    this.name = 'PathParseError';
  }
}

const isIdentStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdentPart = (c: string) => isIdentStart(c) || (c >= '0' && c <= '9');

const HEX = new Set('0123456789abcdefABCDEF');

function readQuoted(input: string, i: number): [string, number] {
  // i points at the opening quote; errors that run off the end are reported
  // at the opening quote so an editor can highlight the whole string.
  const opening = i;
  const quote = input[i];
  let out = '';
  i += 1;
  while (i < input.length) {
    const c = input[i];
    if (c === quote) return [out, i + 1];
    if (c === '\\') {
      const esc = input[i + 1];
      if (esc === undefined) throw new PathParseError('dangling escape; expected a closing quote', i);
      switch (esc) {
        case '"':
        case "'":
        case '\\':
        case '/':
          out += esc;
          break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = input.slice(i + 2, i + 6);
          if (hex.length !== 4 || ![...hex].every((h) => HEX.has(h))) {
            throw new PathParseError('\\u escape needs exactly 4 hex digits', i);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default:
          throw new PathParseError(`bad escape \\${esc}`, i + 1);
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  throw new PathParseError(`unterminated ${quote === '"' ? 'double' : 'single'}-quoted string`, opening);
}

function readBareName(input: string, i: number): [string, number] {
  const start = i;
  if (input[i] >= '0' && input[i] <= '9') {
    throw new PathParseError('bare keys cannot start with a digit; use brackets and quotes, e.g. ["123abc"]', i);
  }
  while (i < input.length && isIdentPart(input[i])) i += 1;
  return [input.slice(start, i), i];
}

function readBracket(input: string, i: number): [PathToken, number] {
  // i points at '['; a bracket that runs off the end reports the bracket
  // itself so an editor can mark the whole construct.
  const opening = i;
  i += 1;
  if (input[i] === undefined) throw new PathParseError('unterminated bracket', opening);
  let token: PathToken;
  if (input[i] === '"' || input[i] === "'") {
    const [key, after] = readQuoted(input, i);
    token = {kind: 'key', key};
    i = after;
  } else if (input[i] >= '0' && input[i] <= '9') {
    const start = i;
    while (i < input.length && input[i] >= '0' && input[i] <= '9') i += 1;
    const digits = input.slice(start, i);
    if (digits.length > 1 && digits[0] === '0') {
      throw new PathParseError('array indices cannot have leading zeros', start + 1);
    }
    token = {kind: 'index', index: Number(digits)};
  } else {
    throw new PathParseError("bracket must contain an index or a quoted key", i);
  }
  if (input[i] !== ']') throw new PathParseError("expected ']'", i);
  return [token, i + 1];
}

/** Parse a path; throws PathParseError (with offset) on any grammar error. */
export function parsePath(input: string): PathToken[] {
  if (input.length === 0) throw new PathParseError('path is empty', 0);
  const tokens: PathToken[] = [];
  let i = 0;
  // First segment: bare name or bracket (no leading dot)
  if (input[i] === '.') throw new PathParseError("path must not start with '.'", i);
  while (i < input.length) {
    if (input[i] === '[') {
      const [token, next] = readBracket(input, i);
      tokens.push(token);
      i = next;
    } else if (isIdentStart(input[i])) {
      const [name, next] = readBareName(input, i);
      tokens.push({kind: 'key', key: name});
      i = next;
    } else {
      throw new PathParseError(`unexpected character '${input[i]}'`, i);
    }
    if (i === input.length) break;
    if (input[i] === '.') {
      i += 1;
      if (i === input.length) throw new PathParseError("path must not end with '.'", i - 1);
      if (input[i] === '.') throw new PathParseError("empty segment between dots", i);
      if (input[i] === '[') throw new PathParseError("do not combine '.' with '[]'; write a[0], not a.[0]", i);
    } else if (input[i] !== '[') {
      throw new PathParseError(`expected '.' or '['`, i);
    }
  }
  return tokens;
}

export interface PathMatch {
  parent: unknown[] | Record<string, unknown>;
  /** Key or index inside parent that holds the matched value. */
  key: string | number;
}

/**
 * Walk `root` along `tokens`. Returns the container + last key when the full
 * chain exists and the container is traversable. A non-existent final slot
 * still matches (returns its would-be parent); a broken chain returns null.
 */
export function locate(root: unknown, tokens: PathToken[]): PathMatch | null {
  if (tokens.length === 0) return null;
  let current: unknown = root;
  for (let depth = 0; depth < tokens.length - 1; depth += 1) {
    const t = tokens[depth];
    if (t.kind === 'key') {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
      if (!Object.prototype.hasOwnProperty.call(current, t.key)) return null;
      current = (current as Record<string, unknown>)[t.key];
    } else {
      if (!Array.isArray(current)) return null;
      if (t.index < 0 || t.index >= current.length) return null;
      current = current[t.index];
    }
  }
  const last = tokens[tokens.length - 1];
  if (last.kind === 'key') {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
  } else if (!Array.isArray(current)) {
    return null;
  }
  return {parent: current as Record<string, unknown> | unknown[], key: last.kind === 'key' ? last.key : last.index};
}

/** Read the value at a parsed path (undefined if absent). */
export function getAt(root: unknown, tokens: PathToken[]): unknown {
  const match = locate(root, tokens);
  if (!match) return undefined;
  if (Array.isArray(match.parent)) return match.parent[match.key as number];
  return match.parent[match.key as string];
}

/** Structural deep clone (JSON data only). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
