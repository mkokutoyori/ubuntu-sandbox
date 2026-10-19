import { PSRuntimeError } from './PSRuntimeError';

const WILDCARD_EXCEPTION = 'System.Management.Automation.WildcardPatternException';
const SPECIAL_CHARS = '*?[]`';
const ESCAPE = '`';

export function hasWildcard(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function invalidPattern(pattern: string): PSRuntimeError {
  return new PSRuntimeError(`The specified wildcard character pattern is not valid: ${pattern}`, WILDCARD_EXCEPTION);
}

function regexLiteral(c: string): string {
  return c.replace(/[.+*?^${}()|[\]\\/-]/g, '\\$&');
}

function bracketExpression(contents: string, operators: string, pattern: string): string {
  let body = '';
  let i = 0;
  while (i < contents.length) {
    if (i + 2 < contents.length && operators[i + 1] === '-') {
      const lower = contents[i];
      const upper = contents[i + 2];
      i += 3;
      if (lower > upper) throw invalidPattern(pattern);
      body += `${regexLiteral(lower)}-${regexLiteral(upper)}`;
    } else {
      body += regexLiteral(contents[i]);
      i++;
    }
  }
  return `[${body}]`;
}

export function wildcardRegexSource(pattern: string): string {
  let source = '';
  let previousIsEscape = false;
  let previousStartedBracket = false;
  let insideRange = false;
  let contents = '';
  let operators = '';
  for (const c of pattern) {
    if (insideRange) {
      if (c === ']' && !previousStartedBracket && !previousIsEscape) {
        insideRange = false;
        source += bracketExpression(contents, operators, pattern);
        contents = '';
        operators = '';
      } else if (c !== ESCAPE || previousIsEscape) {
        contents += c;
        operators += c === '-' && !previousIsEscape ? '-' : ' ';
      }
      previousStartedBracket = false;
    } else if (c === '*' && !previousIsEscape) {
      source += '.*';
    } else if (c === '?' && !previousIsEscape) {
      source += '.';
    } else if (c === '[' && !previousIsEscape) {
      insideRange = true;
      previousStartedBracket = true;
    } else if (c !== ESCAPE || previousIsEscape) {
      source += regexLiteral(c);
    }
    previousIsEscape = c === ESCAPE && !previousIsEscape;
  }
  if (insideRange) throw invalidPattern(pattern);
  if (previousIsEscape && pattern !== ESCAPE) source += regexLiteral(pattern[pattern.length - 1]);
  return source;
}

export function wildcardToRegex(pattern: string): RegExp {
  return new RegExp(`^${wildcardRegexSource(pattern)}$`, 'is');
}

export function wildcardMatches(pattern: string, value: string, caseSensitive = false): boolean {
  return new RegExp(`^${wildcardRegexSource(pattern)}$`, caseSensitive ? 's' : 'is').test(value);
}

export function escapeWildcard(pattern: string): string {
  let escaped = '';
  for (const c of pattern) escaped += SPECIAL_CHARS.includes(c) ? ESCAPE + c : c;
  return escaped;
}

export function unescapeWildcard(pattern: string): string {
  let plain = '';
  let previousIsEscape = false;
  for (const c of pattern) {
    if (c === ESCAPE && !previousIsEscape) {
      previousIsEscape = true;
      continue;
    }
    if (previousIsEscape && !'*?[]'.includes(c)) plain += ESCAPE;
    plain += c;
    previousIsEscape = false;
  }
  if (previousIsEscape) plain += ESCAPE;
  return plain;
}
