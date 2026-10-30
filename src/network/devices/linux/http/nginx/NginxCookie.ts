import { compileNginxRegex } from './NginxRegex';
import { expandNginxVariables, namedCaptureGroups, unknownNginxVariable, type NginxVariableContext } from './NginxVariables';

export interface NginxCookieDirective {
  readonly name: string;
  readonly args: readonly string[];
}

export type CookieRule =
  | { readonly kind: 'text'; readonly pattern: string; readonly replacement: string }
  | { readonly kind: 'regex'; readonly regex: RegExp; readonly replacement: string };

export interface NginxCookieSettings {
  readonly domains: readonly CookieRule[] | null;
  readonly paths: readonly CookieRule[] | null;
}

export const NGINX_COOKIE_DIRECTIVES: ReadonlySet<string> = new Set(['proxy_cookie_domain', 'proxy_cookie_path']);

export const DEFAULT_COOKIE_SETTINGS: NginxCookieSettings = Object.freeze({ domains: null, paths: null });

const ALLOWED_PARENTS: readonly string[] = ['http', 'server', 'location'];

interface RegexForm { readonly pattern: string; readonly caseless: boolean }

function regexForm(name: string, arg: string): RegexForm | null {
  if (!arg.startsWith('~')) return null;
  if (name === 'proxy_cookie_domain') return { pattern: arg.slice(1), caseless: true };
  return arg.startsWith('~*') ? { pattern: arg.slice(2), caseless: true } : { pattern: arg.slice(1), caseless: false };
}

export function checkCookieDirective(
  name: string, args: readonly string[], siblings: readonly NginxCookieDirective[], parent: string | null,
): string | null {
  if (parent === null || !ALLOWED_PARENTS.includes(parent)) return `"${name}" directive is not allowed here`;
  if (args.length < 1 || args.length > 2) return `invalid number of arguments in "${name}" directive`;
  const earlier = siblings.filter((d) => d.name === name);
  if (earlier.some((d) => d.args.length === 1)) return `"${name}" directive is duplicate`;
  if (args.length === 1) {
    if (args[0] !== 'off') return `invalid parameter "${args[0]}"`;
    return earlier.length > 0 ? `"${name}" directive is duplicate` : null;
  }
  const form = regexForm(name, args[0]);
  let declared: ReadonlySet<string> = new Set();
  if (form !== null) {
    const compiled = compileNginxRegex(form.pattern, form.caseless);
    if (typeof compiled === 'string') return compiled;
    declared = namedCaptureGroups(form.pattern);
  } else {
    const unknown = unknownNginxVariable(args[0]);
    if (unknown !== null) return `unknown "${unknown}" variable`;
  }
  const unknown = unknownNginxVariable(args[1], declared);
  return unknown === null ? null : `unknown "${unknown}" variable`;
}

function stripLeadingDot(text: string): string {
  return text.startsWith('.') ? text.slice(1) : text;
}

function ruleOf(name: string, args: readonly string[]): CookieRule {
  const form = regexForm(name, args[0]);
  if (form !== null) {
    const compiled = compileNginxRegex(form.pattern, form.caseless);
    if (typeof compiled !== 'string') return { kind: 'regex', regex: compiled, replacement: args[1] };
  }
  return name === 'proxy_cookie_domain'
    ? { kind: 'text', pattern: stripLeadingDot(args[0]), replacement: stripLeadingDot(args[1]) }
    : { kind: 'text', pattern: args[0], replacement: args[1] };
}

export function resolveCookieSettings(
  parent: NginxCookieSettings, own: readonly NginxCookieDirective[],
): NginxCookieSettings {
  if (own.length === 0) return parent;
  const pick = (name: string, inherited: readonly CookieRule[] | null): readonly CookieRule[] | null => {
    const mine = own.filter((d) => d.name === name);
    if (mine.length === 0) return inherited;
    return mine.some((d) => d.args.length === 1) ? null : mine.map((d) => ruleOf(name, d.args));
  };
  const domains = pick('proxy_cookie_domain', parent.domains);
  const paths = pick('proxy_cookie_path', parent.paths);
  return domains === parent.domains && paths === parent.paths ? parent : { domains, paths };
}

function replaceMatching(
  value: string, prefix: number, rules: readonly CookieRule[], caseless: boolean, variables: NginxVariableContext,
): string | null {
  const tail = value.slice(prefix);
  for (const rule of rules) {
    if (rule.kind === 'regex') {
      const match = rule.regex.exec(value);
      if (match === null) continue;
      const captures = new Map<string, string>();
      match.forEach((group, index) => { if (index > 0) captures.set(String(index), group ?? ''); });
      for (const [key, group] of Object.entries(match.groups ?? {})) captures.set(key, group ?? '');
      return expandNginxVariables(rule.replacement, { ...variables, captures });
    }
    const pattern = expandNginxVariables(rule.pattern, variables);
    const same = caseless ? tail.toLowerCase() === pattern.toLowerCase() : tail.startsWith(pattern);
    if (!same) continue;
    const replacement = expandNginxVariables(rule.replacement, variables);
    return value.slice(0, prefix) + replacement + (caseless ? '' : tail.slice(pattern.length));
  }
  return null;
}

export function rewriteSetCookie(
  cookie: string, settings: NginxCookieSettings, variables: NginxVariableContext,
): string {
  if (settings.domains === null && settings.paths === null) return cookie;
  const attrs = cookie.split(';').map((part) => part.trim()).filter((part) => part !== '').map((part) => {
    const at = part.indexOf('=');
    return at < 0 ? { key: part, value: null as string | null } : { key: part.slice(0, at), value: part.slice(at + 1) };
  });
  if (attrs.length === 0 || attrs[0].value === null) return cookie;

  let changed = false;
  for (let i = 1; i < attrs.length; i++) {
    const { key, value } = attrs[i];
    if (value === null) continue;
    const lower = key.toLowerCase();
    let rewritten: string | null = null;
    if (lower === 'domain' && settings.domains !== null) {
      const dotted = value.startsWith('.') ? 1 : 0;
      rewritten = replaceMatching(value, dotted, settings.domains, true, variables);
    } else if (lower === 'path' && settings.paths !== null) {
      rewritten = replaceMatching(value, 0, settings.paths, false, variables);
    }
    if (rewritten !== null) {
      attrs[i] = { key, value: rewritten };
      changed = true;
    }
  }
  if (!changed) return cookie;
  return attrs.map(({ key, value }) => (value === null ? key : `${key}=${value}`)).join('; ');
}
