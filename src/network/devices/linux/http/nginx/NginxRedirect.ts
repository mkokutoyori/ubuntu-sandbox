import { compileNginxRegex } from './NginxRegex';
import {
  expandNginxVariables, hostWithoutPort, namedCaptureGroups, unknownNginxVariable, type NginxVariableContext,
} from './NginxVariables';

export interface NginxRedirectDirective {
  readonly name: string;
  readonly args: readonly string[];
}

export type ProxyRedirectRule =
  | { readonly kind: 'prefix'; readonly pattern: string; readonly replacement: string }
  | { readonly kind: 'regex'; readonly regex: RegExp; readonly replacement: string }
  | { readonly kind: 'default' };

export type ProxyRedirectPolicy = 'implicit' | 'off' | readonly ProxyRedirectRule[];

export interface NginxRedirectSettings {
  readonly absolute: boolean;
  readonly serverNameInRedirect: boolean;
  readonly portInRedirect: boolean;
  readonly policy: ProxyRedirectPolicy;
}

export const DEFAULT_REDIRECT_SETTINGS: NginxRedirectSettings = Object.freeze({
  absolute: true,
  serverNameInRedirect: false,
  portInRedirect: true,
  policy: 'implicit',
});

const FLAG_DIRECTIVES: ReadonlySet<string> = new Set([
  'absolute_redirect', 'server_name_in_redirect', 'port_in_redirect',
]);

export const NGINX_REDIRECT_DIRECTIVES: ReadonlySet<string> = new Set([...FLAG_DIRECTIVES, 'proxy_redirect']);

const ALLOWED_PARENTS: readonly string[] = ['http', 'server', 'location'];
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export const isRedirectStatus = (status: number): boolean => REDIRECT_STATUSES.has(status);

function regexPattern(arg: string): { readonly pattern: string; readonly caseless: boolean } | null {
  if (!arg.startsWith('~')) return null;
  return arg.startsWith('~*')
    ? { pattern: arg.slice(2), caseless: true }
    : { pattern: arg.slice(1), caseless: false };
}

function checkProxyRedirect(
  args: readonly string[], siblings: readonly NginxRedirectDirective[],
): string | null {
  if (args.length < 1 || args.length > 2) return 'invalid number of arguments in "proxy_redirect" directive';
  const earlier = siblings.filter((d) => d.name === 'proxy_redirect');
  const turnedOff = earlier.some((d) => d.args.length === 1 && d.args[0] === 'off');
  if (turnedOff) return '"proxy_redirect" directive is duplicate';

  if (args.length === 1) {
    if (args[0] === 'off') return earlier.length > 0 ? '"proxy_redirect" directive is duplicate' : null;
    if (args[0] !== 'default') return `invalid parameter "${args[0]}"`;
    const pass = siblings.find((d) => d.name === 'proxy_pass');
    if (pass === undefined) return '"proxy_redirect default" should be placed after the "proxy_pass" directive';
    if (pass.args[0]?.includes('$')) {
      return '"proxy_redirect default" cannot be used with "proxy_pass" directive with variables';
    }
    return null;
  }

  const regex = regexPattern(args[0]);
  let declared: ReadonlySet<string> = new Set();
  if (regex !== null) {
    const compiled = compileNginxRegex(regex.pattern, regex.caseless);
    if (typeof compiled === 'string') return compiled;
    declared = namedCaptureGroups(regex.pattern);
  } else {
    const unknown = unknownNginxVariable(args[0]);
    if (unknown !== null) return `unknown "${unknown}" variable`;
  }
  const unknown = unknownNginxVariable(args[1], declared);
  return unknown === null ? null : `unknown "${unknown}" variable`;
}

export function checkRedirectDirective(
  name: string, args: readonly string[], siblings: readonly NginxRedirectDirective[], parent: string | null,
): string | null {
  if (parent === null || !ALLOWED_PARENTS.includes(parent)) return `"${name}" directive is not allowed here`;
  if (name === 'proxy_redirect') return checkProxyRedirect(args, siblings);
  if (args.length !== 1) return `invalid number of arguments in "${name}" directive`;
  if (siblings.some((d) => d.name === name)) return `"${name}" directive is duplicate`;
  const value = args[0].toLowerCase();
  return value === 'on' || value === 'off'
    ? null
    : `invalid value "${args[0]}" in "${name}" directive, it must be "on" or "off"`;
}

function ruleOf(args: readonly string[]): ProxyRedirectRule {
  if (args.length === 1) return { kind: 'default' };
  const regex = regexPattern(args[0]);
  if (regex === null) return { kind: 'prefix', pattern: args[0], replacement: args[1] };
  const compiled = compileNginxRegex(regex.pattern, regex.caseless);
  return typeof compiled === 'string'
    ? { kind: 'prefix', pattern: args[0], replacement: args[1] }
    : { kind: 'regex', regex: compiled, replacement: args[1] };
}

export function resolveRedirectSettings(
  parent: NginxRedirectSettings, own: readonly NginxRedirectDirective[],
): NginxRedirectSettings {
  if (own.length === 0) return parent;
  let { absolute, serverNameInRedirect, portInRedirect, policy } = parent;
  const rules: ProxyRedirectRule[] = [];
  let declared = false;
  let off = false;
  for (const { name, args } of own) {
    const on = args[0]?.toLowerCase() === 'on';
    if (name === 'absolute_redirect') absolute = on;
    else if (name === 'server_name_in_redirect') serverNameInRedirect = on;
    else if (name === 'port_in_redirect') portInRedirect = on;
    else if (name === 'proxy_redirect') {
      declared = true;
      if (args.length === 1 && args[0] === 'off') off = true;
      else rules.push(ruleOf(args));
    }
  }
  if (declared) policy = off ? 'off' : rules;
  return { absolute, serverNameInRedirect, portInRedirect, policy };
}

export interface RedirectRewriteContext {
  readonly passUrl: string;
  readonly passHasUri: boolean;
  readonly locationPath: string;
  readonly variables: NginxVariableContext;
}

const IMPLICIT_RULES: readonly ProxyRedirectRule[] = [{ kind: 'default' }];

function defaultRule(ctx: RedirectRewriteContext): { pattern: string; replacement: string } {
  return ctx.passHasUri
    ? { pattern: ctx.passUrl, replacement: ctx.locationPath }
    : { pattern: `${ctx.passUrl}/`, replacement: '/' };
}

function spliced(value: string, prefix: number, replaced: number, replacement: string): string {
  return value.slice(0, prefix) + replacement + value.slice(prefix + replaced);
}

export function rewriteRedirectValue(
  value: string, prefix: number, policy: ProxyRedirectPolicy, ctx: RedirectRewriteContext,
): string | null {
  if (policy === 'off') return null;
  const rules = policy === 'implicit' ? IMPLICIT_RULES : policy;
  const length = value.length - prefix;
  for (const rule of rules) {
    if (rule.kind === 'regex') {
      const match = rule.regex.exec(value.slice(prefix));
      if (match === null) continue;
      const captures = new Map<string, string>();
      match.forEach((group, index) => { if (index > 0) captures.set(String(index), group ?? ''); });
      for (const [name, group] of Object.entries(match.groups ?? {})) captures.set(name, group ?? '');
      return spliced(value, prefix, length, expandNginxVariables(rule.replacement, { ...ctx.variables, captures }));
    }
    const { pattern, replacement } = rule.kind === 'default'
      ? defaultRule(ctx)
      : { pattern: expandNginxVariables(rule.pattern, ctx.variables), replacement: rule.replacement };
    if (pattern.length > length || !value.startsWith(pattern, prefix)) continue;
    return spliced(value, prefix, pattern.length, expandNginxVariables(replacement, ctx.variables));
  }
  return null;
}

export interface AbsoluteLocationContext {
  readonly hostHeader: string;
  readonly serverName: string;
  readonly port: number;
  readonly secure: boolean;
}

export function absoluteLocationValue(
  value: string, settings: NginxRedirectSettings, ctx: AbsoluteLocationContext,
): string {
  if (!settings.absolute || !value.startsWith('/')) return value;
  const host = settings.serverNameInRedirect && ctx.serverName !== ''
    ? ctx.serverName
    : hostWithoutPort(ctx.hostHeader);
  const defaultPort = ctx.secure ? 443 : 80;
  const port = settings.portInRedirect && ctx.port !== defaultPort ? `:${ctx.port}` : '';
  return `${ctx.secure ? 'https' : 'http'}://${host}${port}${value}`;
}
