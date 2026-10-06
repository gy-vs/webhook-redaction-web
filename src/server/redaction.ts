import type { BodyKind, RedactionRule, RuleAction } from '../shared/types.js';
import {
  applyAtPath, DELETE_TOKEN, parsePath, resolvePath, type PathParseError,
} from './jsonpath.js';

/** 规则配置本身的校验错误（比如路径写错），column 指向出错字符。 */
export interface RuleValidation {
  ruleId: string;
  message: string;
  column?: number;
}

export function validateRule(rule: RedactionRule): RuleValidation | null {
  if (!rule.name.trim()) return { ruleId: rule.id, message: '规则名称不能为空' };
  if (rule.target.kind === 'jsonPath') {
    try {
      parsePath(rule.target.path);
    } catch (e) {
      const err = e as PathParseError;
      return { ruleId: rule.id, message: err.message, column: err.column };
    }
  } else if (!rule.target.name.trim()) {
    return { ruleId: rule.id, message: '请求头名不能为空' };
  }
  if (rule.action.type === 'last') {
    if (!Number.isInteger(rule.action.keep) || rule.action.keep <= 0) {
      return { ruleId: rule.id, message: '保留位数必须是正整数' };
    }
  }
  if (rule.action.type === 'replace' && rule.action.text === '') {
    return { ruleId: rule.id, message: '替换文本不能为空' };
  }
  return null;
}

export function validateRules(rules: RedactionRule[]): RuleValidation[] {
  return rules.map(validateRule).filter((r): r is RuleValidation => r !== null);
}

/** 对字符串值执行处理动作。删除动作由调用方处理（需要删容器项）。 */
export function applyAction(value: string, action: RuleAction): string | typeof DELETE_TOKEN {
  switch (action.type) {
    case 'remove':
      return DELETE_TOKEN;
    case 'replace':
      return action.text;
    case 'last': {
      const tail = value.slice(-action.keep);
      return action.mask + tail;
    }
  }
}

function maskScalar(value: unknown, action: RuleAction): unknown {
  if (typeof value !== 'string') {
    // 非字符串（卡号偶尔以数字出现）先转字符串再处理，长度按原始字符算
    if (action.type === 'remove') return DELETE_TOKEN;
    if (action.type === 'replace') return action.text;
    const s = String(value);
    return action.mask + s.slice(-action.keep);
  }
  return applyAction(value, action);
}

interface ParseableBody {
  bodyKind: BodyKind;
  body: unknown;
  rawText: string | null;
}

/**
 * 在已解析的请求表示上执行规则。
 * - header 规则：命中头删除/替换；last 作用于头值；
 * - jsonPath 规则：命中任意 JSON 形态的正文（json / form / multipart 字段）；
 * - text 正文无法按路径命中，规则不生效（原始文本本身整体照存，
 *   需要隐藏请改用 replace 文本匹配之外的手段——本地调试台按结构规则处理）。
 * 任何被处理的原值都不会出现在返回结构里。
 */
export function applyRules(
  input: ParseableBody,
  headers: Record<string, string>,
  rules: RedactionRule[],
): { body: ParseableBody; headers: Record<string, string>; touched: number } {
  const nextHeaders = { ...headers };
  let work: ParseableBody = input;
  let touched = 0;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.target.kind === 'header') {
      const lk = rule.target.name.toLowerCase();
      const hitKey = Object.keys(nextHeaders).find(k => k.toLowerCase() === lk);
      if (hitKey !== undefined) {
        const result = applyAction(nextHeaders[hitKey], rule.action);
        if (result === DELETE_TOKEN) delete nextHeaders[hitKey];
        else nextHeaders[hitKey] = result;
        touched++;
      }
      continue;
    }

    // jsonPath 规则只对结构化正文有意义
    if (work.bodyKind === 'json' || work.bodyKind === 'form' || work.bodyKind === 'multipart') {
      let segments;
      try {
        segments = parsePath(rule.target.path);
      } catch {
        continue; // 已在 validateRules 阶段拦住，这里防御性跳过
      }
      const root = work.body;
      const current = resolvePath(root, segments);
      if (current === undefined) continue;
      const masked = maskScalar(current, rule.action);
      const nextRoot = applyAtPath(root, segments, masked);
      work = { ...work, body: nextRoot };
      touched++;
    }
  }

  return { body: work, headers: nextHeaders, touched };
}
