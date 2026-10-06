import {cloneJson, getAt, locate, parsePath, PathParseError, PathToken} from '../shared/jsonpath';
import type {BodyKind, RedactionRule} from '../shared/types';

export type {PathParseError} from '../shared/jsonpath';

/** Apply one mask action to a scalar (or anything coercible to string). */
export function maskValue(
  value: unknown,
  action: RedactionRule['action'],
  replacement: string | undefined,
  keepLast: number | undefined,
): unknown {
  if (action === 'drop') return undefined; // signal: remove the slot
  if (action === 'replace') return replacement ?? '';
  const text = value === null || value === undefined ? '' : String(value);
  if (!keepLast || keepLast <= 0) return '';
  return text.slice(-keepLast);
}

interface BodyBodyRule {
  tokens: PathToken[];
  rule: RedactionRule;
}

function compileBodyRules(rules: RedactionRule[]): BodyBodyRule[] {
  const compiled: BodyBodyRule[] = [];
  for (const rule of rules) {
    if (rule.scope !== 'body') continue;
    try {
      compiled.push({tokens: parsePath(rule.target), rule});
    } catch {
      // Invalid targets are rejected when a source is saved; a rule that
      // somehow fails to compile here is skipped rather than leaking.
    }
  }
  return compiled;
}

/** Apply body rules to a deep clone of the parsed tree. */
export function redactTree<T>(tree: T, rules: RedactionRule[]): T {
  const out = cloneJson(tree);
  // Locate every target on the original clone first, so deleting an array
  // element cannot shift a later rule's index.
  const ops = compileBodyRules(rules)
    .map((entry) => ({match: locate(out, entry.tokens), entry}))
    .filter((op): op is {match: NonNullable<ReturnType<typeof locate>>; entry: BodyBodyRule} => op.match !== null);

  // Replacements and tails don't move siblings; do them first (rule order).
  for (const {match, entry} of ops) {
    if (entry.rule.action === 'drop') continue;
    const value = Array.isArray(match.parent)
      ? match.parent[match.key as number]
      : match.parent[match.key as string];
    const result = maskValue(value, entry.rule.action, entry.rule.replacement, entry.rule.keepLast);
    if (Array.isArray(match.parent)) match.parent[match.key as number] = result;
    else match.parent[match.key as string] = result as string;
  }

  // Drops: per array, highest indices first so earlier indices stay valid.
  const arrayDrops = new Map<unknown[], Set<number>>();
  for (const {match, entry} of ops) {
    if (entry.rule.action !== 'drop' || !Array.isArray(match.parent)) continue;
    const set = arrayDrops.get(match.parent) ?? new Set<number>();
    set.add(match.key as number);
    arrayDrops.set(match.parent, set);
  }
  for (const [parent, indices] of arrayDrops) {
    for (const index of [...indices].sort((a, b) => b - a)) parent.splice(index, 1);
  }
  for (const {match, entry} of ops) {
    if (entry.rule.action === 'drop' && !Array.isArray(match.parent)) {
      delete match.parent[match.key as string];
    }
  }
  return out;
}

/** Apply header rules; matching is case-insensitive. */
export function redactHeaders(
  headers: Record<string, string>,
  rules: RedactionRule[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const active = rules
    .filter((r) => r.scope === 'header')
    .map((r) => ({name: r.target.toLowerCase(), rule: r}));
  for (const [name, value] of Object.entries(headers)) {
    const hit = active.find((a) => a.name === name.toLowerCase());
    if (!hit) {
      out[name] = value;
      continue;
    }
    if (hit.rule.action === 'drop') continue;
    out[name] = String(maskValue(value, hit.rule.action, hit.rule.replacement, hit.rule.keepLast));
  }
  return out;
}

/** Split a Content-Type header into its media type + parameters. */
export function parseContentType(header: string | undefined): {media: string; charset: string} {
  if (!header) return {media: '', charset: ''};
  const parts = header.split(';').map((p) => p.trim());
  const media = (parts[0] || '').toLowerCase();
  const charset = (parts.slice(1).find((p) => p.toLowerCase().startsWith('charset=')) || '')
    .slice('charset='.length)
    .replace(/^"|"$/g, '');
  return {media, charset};
}

export interface ParsedBody {
  kind: BodyKind;
  tree: unknown; // object/array for json/form, null otherwise
}

/** Parse captured bytes the same way the UI explains it. */
export function parseBody(raw: Buffer, contentType: string | undefined): ParsedBody {
  if (raw.length === 0) return {kind: 'empty', tree: null};
  const {media} = parseContentType(contentType);
  if (media === 'application/json' || isJsonLooking(raw, media)) {
    try {
      return {kind: 'json', tree: JSON.parse(raw.toString('utf8')) as unknown};
    } catch {
      if (media === 'application/json') return {kind: 'text', tree: null};
    }
  }
  if (media === 'application/x-www-form-urlencoded') {
    return {kind: 'form', tree: formToTree(raw.toString('utf8'))};
  }
  return {kind: 'text', tree: null};
}

function isJsonLooking(raw: Buffer, media: string): boolean {
  if (media && media.endsWith('+json')) return true;
  if (media) return false;
  const head = raw.toString('utf8', 0, Math.min(raw.length, 64)).trimStart();
  return head.startsWith('{') || head.startsWith('[');
}

function formToTree(text: string): Record<string, unknown> {
  const params = new URLSearchParams(text);
  const tree: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    tree[key] = all.length === 1 ? all[0] : all;
  }
  return tree;
}

/** Re-serialise a (redacted) parsed tree back into wire text. */
export function serialiseTree(kind: BodyKind, tree: unknown, fallbackText: string): string {
  if (kind === 'json') return JSON.stringify(tree);
  if (kind === 'form') {
    const params = new URLSearchParams();
    const walk = (key: string, value: unknown) => {
      if (Array.isArray(value)) value.forEach((v) => params.append(key, scalar(v)));
      else params.set(key, scalar(value));
    };
    if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
      for (const [k, v] of Object.entries(tree as Record<string, unknown>)) walk(k, v);
    }
    return params.toString();
  }
  return fallbackText;
}

function scalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Full capture-time redaction: headers + parsed tree + wire text. */
export function redactCapture(
  headers: Record<string, string>,
  raw: Buffer,
  contentType: string | undefined,
  rules: RedactionRule[],
): {headers: Record<string, string>; kind: BodyKind; tree: unknown; text: string} {
  const safeHeaders = redactHeaders(headers, rules);
  const parsed = parseBody(raw, contentType);
  if (parsed.kind === 'json' || parsed.kind === 'form') {
    const tree = redactTree(parsed.tree, rules);
    return {
      headers: safeHeaders,
      kind: parsed.kind,
      tree,
      text: serialiseTree(parsed.kind, tree, ''),
    };
  }
  // Plain text has no field paths; body rules cannot target it.
  const text = raw.toString('utf8');
  return {headers: safeHeaders, kind: parsed.kind, tree: null, text};
}

/** Re-apply rules to a stored snapshot (replay uses the *current* rules). */
export function redactStored(
  headers: Record<string, string>,
  kind: BodyKind,
  tree: unknown,
  text: string,
  rules: RedactionRule[],
): {headers: Record<string, string>; tree: unknown; text: string} {
  const safeHeaders = redactHeaders(headers, rules);
  if (kind === 'json' || kind === 'form') {
    const nextTree = redactTree(tree, rules);
    return {headers: safeHeaders, tree: nextTree, text: serialiseTree(kind, nextTree, text)};
  }
  return {headers: safeHeaders, tree, text};
}

export function validatePath(target: string): {valid: true; tokens: PathToken[]} | {valid: false; offset: number; message: string} {
  try {
    return {valid: true, tokens: parsePath(target)};
  } catch (err) {
    if (err instanceof PathParseError) return {valid: false, offset: err.offset, message: err.message};
    throw err;
  }
}
