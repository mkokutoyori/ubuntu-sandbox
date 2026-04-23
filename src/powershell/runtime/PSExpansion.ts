/**
 * PSExpansion — Expandable string engine for PowerShell double-quoted strings.
 *
 * Handles:
 *   - $variableName  and  ${braced}  variable insertion
 *   - $env:VAR  scope-qualified variables
 *   - Backtick escape sequences: `n `t `r `" `` `$ `0 `a `b `f `v
 *   - $(subexpr)  — recursive sub-expression evaluation (via callback)
 */

import type { PSEnvironment, PSValue } from './PSEnvironment';

/** Callback type for evaluating a $(…) sub-expression string. */
export type SubExprEvaluator = (code: string) => PSValue;

// ─── Backtick escape table ────────────────────────────────────────────────────

const BACKTICK: Record<string, string> = {
  n:  '\n',
  t:  '\t',
  r:  '\r',
  '"': '"',
  "'": "'",
  '`': '`',
  '$': '$',
  '0': '\0',
  a:  '\x07',
  b:  '\x08',
  f:  '\x0C',
  v:  '\x0B',
};

// ─── Main expand function ─────────────────────────────────────────────────────

/**
 * Expands a raw double-quoted string value (without surrounding quotes) into
 * the final string by substituting variables and processing backtick escapes.
 *
 * @param raw   The content between the double-quote delimiters.
 * @param env   Variable scope used for $name lookups.
 * @param evalSubExpr  Optional callback for $(…) sub-expression evaluation.
 */
export function expandString(
  raw: string,
  env: PSEnvironment,
  evalSubExpr?: SubExprEvaluator,
): string {
  let result = '';
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    // ── Backtick escape ──────────────────────────────────────────────────
    if (ch === '`' && i + 1 < raw.length) {
      const next = raw[i + 1];
      result += BACKTICK[next] ?? next;
      i += 2;
      continue;
    }

    // ── Variable / sub-expression ────────────────────────────────────────
    if (ch === '$') {
      i++; // consume '$'

      if (i >= raw.length) {
        result += '$';
        continue;
      }

      const next = raw[i];

      // $( subexpression )
      if (next === '(' && evalSubExpr) {
        const [inner, end] = readBalancedParens(raw, i + 1);
        result += psValueToString(evalSubExpr(inner));
        i = end + 1;
        continue;
      }

      // ${braced} or ${env:VAR}
      if (next === '{') {
        const close = raw.indexOf('}', i + 1);
        if (close !== -1) {
          const name = raw.slice(i + 1, close);
          result += psValueToString(resolveVar(name, env));
          i = close + 1;
          continue;
        }
        result += '$';
        continue;
      }

      // $scope:name  or  $name
      if (isIdentStart(next)) {
        let j = i;
        while (j < raw.length && isIdentChar(raw[j])) j++;
        const part = raw.slice(i, j);

        // Check for scope qualifier: $env:VAR, $global:X, etc.
        if (j < raw.length && raw[j] === ':' && j + 1 < raw.length && isIdentChar(raw[j + 1])) {
          let k = j + 1;
          while (k < raw.length && isIdentChar(raw[k])) k++;
          const scopedName = raw.slice(i, k);
          result += psValueToString(resolveVar(scopedName, env));
          i = k;
        } else {
          result += psValueToString(resolveVar(part, env));
          i = j;
        }
        continue;
      }

      // Literal '$' (not followed by identifier)
      result += '$';
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_?]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_?]/.test(ch);
}

/**
 * Resolves a variable name (possibly scope-qualified) against the environment.
 * Handles: name, env:NAME, global:name, script:name, local:name
 */
function resolveVar(name: string, env: PSEnvironment): PSValue {
  const lower = name.toLowerCase();
  const colonIdx = lower.indexOf(':');
  if (colonIdx !== -1) {
    const scope = lower.slice(0, colonIdx);
    const varName = name.slice(colonIdx + 1);
    if (scope === 'global') return env.getGlobal(varName);
    if (scope === 'env') return process.env[varName.toUpperCase()] ?? null;
    // local:, script: — treat as plain local read
    return env.get(varName);
  }
  return env.get(name);
}

/** Converts a PSValue to string (matching PowerShell's default formatting). */
export function psValueToString(value: PSValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(psValueToString).join(' ');
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, PSValue>);
    if (entries.length === 0) return '';
    // Hashtable-style formatting
    return entries.map(([k, v]) => `${k}=${psValueToString(v)}`).join('; ');
  }
  return String(value);
}

/**
 * Reads the inner content of balanced parentheses starting at `start`
 * (the index of the char AFTER the opening paren).
 * Returns [innerContent, indexOfClosingParen].
 */
function readBalancedParens(src: string, start: number): [string, number] {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return [src.slice(start, i), i];
    }
    i++;
  }
  return [src.slice(start), src.length - 1];
}
