// 极简 JSON 路径解析器：只支持 $.a.b、$["a.b"]、$[12]、$["x"][0] 这几种写法。
// 特意不支持通配/递归/脚本/切片，语法比现成 JSONPath 包窄得多。
// 解析错误一律带 column（从 1 开始、基于用户原始输入的字符位置），前端原样显示。

export type JsonValue = unknown;
export type Segment = { type: 'key'; value: string } | { type: 'index'; value: number };

export interface PathParseError extends Error {
  code: 'JSONPATH_PARSE_ERROR';
  column: number;
}

function failure(message: string, column: number): PathParseError {
  const err = new Error(`JSON 路径第 ${column} 个字符处有问题：${message}`) as PathParseError;
  err.code = 'JSONPATH_PARSE_ERROR';
  err.column = column;
  return err;
}

const ESCAPES: Record<string, string> = {
  '"': '"', "'": "'", '\\': '\\', '/': '/',
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

export function parsePath(rawInput: string): Segment[] {
  const input = rawInput;
  const path = input.trim();
  if (path.length === 0) throw failure('路径不能为空', 1);
  const leading = input.length - input.trimStart().length;
  const pos = (p: number) => leading + p + 1;

  if (path[0] !== '$') throw failure('路径必须以 $ 开头', pos(0));
  let i = 1;
  const segments: Segment[] = [];

  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      if (path[i + 1] === '.') throw failure('不支持递归下降 ..', pos(i + 1));
      const start = i + 1;
      if (start >= path.length) throw failure('点号后面缺少键名', pos(i));
      if (path[start] === '*') throw failure('不支持通配符 *', pos(start));
      if (path[start] === '[') throw failure('点号后不能直接跟 [，请去掉点号', pos(start));
      let j = start;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      const name = path.slice(start, j);
      let k = 0;
      if (!/[A-Za-z_$]/.test(name[0])) {
        k = 0;
      } else {
        while (k < name.length && /[A-Za-z0-9_$]/.test(name[k])) ++k;
      }
      if (k < name.length) {
        throw failure(`键名 ${JSON.stringify(name)} 含非法字符，含点号或特殊字符的键请用 ["..."] 包起来`, pos(start + k));
      }
      segments.push({ type: 'key', value: name });
      i = j;
    } else if (ch === '[') {
      const close = path.indexOf(']', i + 1);
      if (close === -1) throw failure('缺少右方括号 ]', pos(path.length));
      const inside = path.slice(i + 1, close);
      if (inside.length === 0) throw failure('方括号里不能为空，需要键名或下标', pos(i + 1));
      const dq = inside.startsWith('"') && inside.endsWith('"') && inside.length >= 2;
      const sq = inside.startsWith("'") && inside.endsWith("'") && inside.length >= 2;
      if (dq || sq) {
        const quote = dq ? '"' : "'";
        const raw = inside.slice(1, -1);
        // 引号必须成对：中间出现未转义的同类引号说明提前闭合
        for (let k = 0; k < raw.length; k++) {
          if (raw[k] === '\\') { k++; continue; }
          if (raw[k] === quote) throw failure(`键名里的 ${quote} 需要用 \\${quote} 转义`, pos(i + 2 + k));
        }
        let value = '';
        for (let k = 0; k < raw.length; k++) {
          const c = raw[k];
          if (c !== '\\') { value += c; continue; }
          const n = raw[k + 1];
          if (n === undefined) throw failure('转义符 \\ 后面缺少字符', pos(i + 2 + k));
          if (n === 'u') {
            const hex = raw.slice(k + 2, k + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw failure('\\u 后面需要 4 位十六进制数', pos(i + 2 + k));
            value += String.fromCharCode(parseInt(hex, 16));
            k += 5;
          } else if (n in ESCAPES) {
            value += ESCAPES[n];
            k += 1;
          } else {
            throw failure(`不认识的转义 \\${n}`, pos(i + 3 + k));
          }
        }
        segments.push({ type: 'key', value });
      } else if (/^0$|^[1-9][0-9]*$/.test(inside)) {
        segments.push({ type: 'index', value: Number(inside) });
      } else if (/^-?[0-9]+$/.test(inside)) {
        const bad = inside.startsWith('-') ? 0 : inside.indexOf('0');
        throw failure(inside.startsWith('-') ? '数组下标不能为负数' : '数字下标不能以 0 开头', pos(i + 1 + bad));
      } else {
        throw failure('方括号里只能是引号包起来的键名或非负整数下标', pos(i + 1));
      }
      i = close + 1;
    } else {
      throw failure(`意外的字符 ${JSON.stringify(ch)}，段与段之间需要用 . 或 ["..."] 连接`, pos(i));
    }
  }
  return segments;
}

export function resolvePath(root: JsonValue, segments: Segment[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (seg.type === 'index') {
      if (!Array.isArray(cur) || seg.value >= cur.length) return undefined;
      cur = cur[seg.value];
    } else {
      if (Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.value];
    }
  }
  return cur;
}

/** 替换/删除标记：applyAtPath 遇到它会删掉目标键或数组元素 */
export const DELETE_TOKEN = Symbol('jsonpath-delete');

/**
 * 沿路径在不可变副本上改值。中间缺失或类型不符的容器会按路径补建，
 * 这样规则预览时能直观看到落点；未命中的分支与原对象共享引用。
 */
export function applyAtPath(root: JsonValue, segments: Segment[], value: unknown): JsonValue {
  const visit = (node: JsonValue, depth: number): JsonValue => {
    const seg = segments[depth];
    if (depth === segments.length - 1) {
      if (seg.type === 'index') {
        const arr = Array.isArray(node) ? node.slice() : [];
        while (arr.length < seg.value) arr.push(undefined);
        if (value === DELETE_TOKEN) {
          if (seg.value < arr.length) arr.splice(seg.value, 1);
        } else {
          arr[seg.value] = value;
        }
        return arr;
      }
      const obj = node && typeof node === 'object' && !Array.isArray(node)
        ? { ...(node as Record<string, unknown>) } : {};
      if (value === DELETE_TOKEN) delete obj[seg.value];
      else obj[seg.value] = value;
      return obj;
    }
    if (seg.type === 'index') {
      const arr = Array.isArray(node) ? node.slice() : [];
      while (arr.length <= seg.value) arr.push(undefined);
      arr[seg.value] = visit(arr[seg.value], depth + 1);
      return arr;
    }
    const obj = node && typeof node === 'object' && !Array.isArray(node)
      ? { ...(node as Record<string, unknown>) } : {};
    obj[seg.value] = visit(obj[seg.value], depth + 1);
    return obj;
  };
  return visit(root, 0);
}
