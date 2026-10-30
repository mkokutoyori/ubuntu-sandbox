import type { HttpMessage } from '@/network/http/semantics/types';

export interface NginxVariableContext {
  readonly request: HttpMessage;
  readonly clientIp: string;
  readonly secure: boolean;
  readonly serverName: string;
  readonly serverPort: number;
  readonly upstream: { readonly host: string; readonly port: number } | null;
  readonly captures?: ReadonlyMap<string, string>;
  readonly uri?: string;
  readonly args?: string;
  readonly root?: string;
  readonly variables?: ReadonlyMap<string, string>;
}

const TOKEN = /\$(?:\{(\w+)\}|(\w+))/g;

const FIXED_NAMES: ReadonlySet<string> = new Set([
  'proxy_add_x_forwarded_for', 'proxy_host', 'proxy_port', 'host', 'remote_addr', 'scheme',
  'request_uri', 'uri', 'request_method', 'server_name', 'server_port', 'args', 'query_string', 'is_args',
  'document_root', 'request_filename', 'server_protocol', 'content_type', 'content_length',
]);

let userVariables: ReadonlySet<string> = new Set();

let collecting: Set<string> | null = null;

export function declareUserVariables(names: ReadonlySet<string>): void {
  userVariables = names;
}

export function currentUserVariables(): ReadonlySet<string> {
  return userVariables;
}

export function beginVariableCollection(): void {
  collecting = new Set();
}

export function noteUserVariable(name: string): void {
  collecting?.add(name);
}

export function endVariableCollection(): ReadonlySet<string> {
  const found = collecting ?? new Set<string>();
  collecting = null;
  return found;
}

export function isBuiltInNginxVariable(name: string): boolean {
  return FIXED_NAMES.has(name) || name.startsWith('http_') || name.startsWith('arg_') || name.startsWith('cookie_') || /^\d+$/.test(name);
}

export function isKnownNginxVariable(name: string): boolean {
  return isBuiltInNginxVariable(name) || userVariables.has(name);
}

export function unknownNginxVariable(template: string, declared: ReadonlySet<string> = new Set()): string | null {
  if (collecting !== null) return null;
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1] ?? match[2];
    if (!isKnownNginxVariable(name) && !declared.has(name)) return name;
  }
  return null;
}

export function namedCaptureGroups(pattern: string): ReadonlySet<string> {
  return new Set([...pattern.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]));
}

export function hostWithoutPort(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    return close < 0 ? hostHeader : hostHeader.slice(0, close + 1);
  }
  const colon = hostHeader.lastIndexOf(':');
  return colon < 0 ? hostHeader : hostHeader.slice(0, colon);
}

function requestArgs(target: string | undefined): string {
  const at = (target ?? '').indexOf('?');
  return at < 0 ? '' : (target ?? '').slice(at + 1);
}

function queryArgument(args: string, wanted: string): string {
  for (const pair of args.split('&')) {
    const at = pair.indexOf('=');
    if ((at < 0 ? pair : pair.slice(0, at)) === wanted) return at < 0 ? '' : pair.slice(at + 1);
  }
  return '';
}

function cookieValue(header: string, wanted: string): string {
  for (const pair of header.split(';')) {
    const text = pair.trim();
    const at = text.indexOf('=');
    if (at > 0 && text.slice(0, at) === wanted) return text.slice(at + 1);
  }
  return '';
}

function resolve(name: string, ctx: NginxVariableContext): string | null {
  const captured = ctx.captures?.get(name);
  if (captured !== undefined) return captured;
  const assigned = ctx.variables?.get(name);
  if (assigned !== undefined) return assigned;
  if (/^\d+$/.test(name)) return '';
  const headers = ctx.request.headers;
  switch (name) {
    case 'proxy_add_x_forwarded_for': {
      const received = headers.get('X-Forwarded-For');
      return received ? `${received}, ${ctx.clientIp}` : ctx.clientIp;
    }
    case 'proxy_host': return ctx.upstream ? `${ctx.upstream.host}:${ctx.upstream.port}` : '';
    case 'proxy_port': return ctx.upstream ? String(ctx.upstream.port) : '';
    case 'host': return hostWithoutPort(headers.get('Host') ?? '');
    case 'remote_addr': return ctx.clientIp;
    case 'scheme': return ctx.secure ? 'https' : 'http';
    case 'request_uri': return ctx.request.target ?? '/';
    case 'uri': return ctx.uri ?? (ctx.request.target ?? '/').split('?')[0];
    case 'args':
    case 'query_string': return ctx.args ?? requestArgs(ctx.request.target);
    case 'is_args': return (ctx.args ?? requestArgs(ctx.request.target)) === '' ? '' : '?';
    case 'document_root': return ctx.root ?? '';
    case 'request_filename': return `${ctx.root ?? ''}${ctx.uri ?? (ctx.request.target ?? '/').split('?')[0]}`;
    case 'server_protocol': return `HTTP/${ctx.request.httpVersion}`;
    case 'content_type': return headers.get('Content-Type') ?? '';
    case 'content_length': return headers.get('Content-Length') ?? '';
    case 'request_method': return ctx.request.method ?? 'GET';
    case 'server_name': return ctx.serverName;
    case 'server_port': return String(ctx.serverPort);
    default:
      if (name.startsWith('arg_')) return queryArgument(ctx.args ?? requestArgs(ctx.request.target), name.slice(4));
      if (name.startsWith('cookie_')) return cookieValue(headers.get('Cookie') ?? '', name.slice(7));
      return name.startsWith('http_') ? (headers.get(name.slice(5).replace(/_/g, '-')) ?? '') : null;
  }
}

export function expandNginxVariables(template: string, ctx: NginxVariableContext): string {
  if (!template.includes('$')) return template;
  return template.replace(TOKEN, (whole, braced: string | undefined, bare: string | undefined) => {
    const value = resolve(braced ?? bare ?? '', ctx);
    return value === null ? whole : value;
  });
}
