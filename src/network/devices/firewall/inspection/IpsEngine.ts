export type IpsSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type IpsContext = 'uri' | 'header' | 'body' | 'host' | 'packet';
export type IpsFlow = 'from_client' | 'from_server' | 'bi_direction';

export interface IpsPattern {
  readonly text: string;
  readonly context: IpsContext;
  readonly noCase: boolean;
}

export interface IpsSignatureBody {
  readonly name: string;
  readonly protocol?: 'tcp' | 'udp';
  readonly service?: string;
  readonly flow: IpsFlow;
  readonly patterns: readonly IpsPattern[];
  readonly destinationPort?: number;
  readonly sourcePort?: number;
  readonly severity?: IpsSeverity;
  readonly defaultAction?: 'pass' | 'drop';
}

export type IpsParseResult =
  | { readonly ok: true; readonly signature: IpsSignatureBody }
  | { readonly ok: false; readonly error: string };

const SEVERITIES: readonly IpsSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
const CONTEXTS: readonly IpsContext[] = ['uri', 'header', 'body', 'host', 'packet'];
const SERVICE_PORTS: Readonly<Record<string, number>> = Object.freeze({
  HTTP: 80, HTTPS: 443, FTP: 21, SMTP: 25, DNS: 53, TELNET: 23, SSH: 22, POP3: 110, IMAP: 143,
});

function splitClauses(body: string): string[] {
  const clauses: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of body) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) {
      if (current.trim() !== '') clauses.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') clauses.push(current.trim());
  return clauses;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1) : trimmed;
}

export function parseIpsSignature(text: string): IpsParseResult {
  const match = /^\s*F-SBID\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (match === null) return { ok: false, error: 'a custom signature reads F-SBID( --name "..."; ... )' };

  let name: string | undefined;
  let protocol: 'tcp' | 'udp' | undefined;
  let service: string | undefined;
  let flow: IpsFlow = 'bi_direction';
  let destinationPort: number | undefined;
  let sourcePort: number | undefined;
  let severity: IpsSeverity | undefined;
  let defaultAction: 'pass' | 'drop' | undefined;
  const patterns: Array<{ text: string; context: IpsContext; noCase: boolean }> = [];

  for (const clause of splitClauses(match[1])) {
    const keyword = /^--(\w+)\s*(.*)$/s.exec(clause);
    if (keyword === null) return { ok: false, error: `cannot read \`${clause}\`` };
    const [, key, raw] = keyword;
    const value = unquote(raw);
    switch (key) {
      case 'name': name = value; break;
      case 'protocol':
        if (value !== 'tcp' && value !== 'udp') return { ok: false, error: `--protocol ${value} is not scanned (tcp or udp)` };
        protocol = value;
        break;
      case 'service': service = value.toUpperCase(); break;
      case 'flow':
        if (value !== 'from_client' && value !== 'from_server' && value !== 'bi_direction') {
          return { ok: false, error: `--flow ${value} is not from_client, from_server or bi_direction` };
        }
        flow = value;
        break;
      case 'dst_port': case 'src_port': {
        const port = Number.parseInt(value, 10);
        if (!Number.isInteger(port) || port < 0 || port > 65535) return { ok: false, error: `--${key} ${value} is not a port` };
        if (key === 'dst_port') destinationPort = port; else sourcePort = port;
        break;
      }
      case 'severity':
        if (!SEVERITIES.includes(value as IpsSeverity)) return { ok: false, error: `--severity ${value} is not one of ${SEVERITIES.join(', ')}` };
        severity = value as IpsSeverity;
        break;
      case 'default_action':
        if (value !== 'pass' && value !== 'drop') return { ok: false, error: `--default_action ${value} is not pass or drop` };
        defaultAction = value;
        break;
      case 'pattern':
        if (value === '') return { ok: false, error: '--pattern needs a non-empty string' };
        patterns.push({ text: value, context: 'packet', noCase: false });
        break;
      case 'context': {
        const last = patterns[patterns.length - 1];
        if (last === undefined) return { ok: false, error: '--context follows the --pattern it qualifies' };
        if (!CONTEXTS.includes(value as IpsContext)) return { ok: false, error: `--context ${value} is not one of ${CONTEXTS.join(', ')}` };
        last.context = value as IpsContext;
        break;
      }
      case 'no_case': {
        const last = patterns[patterns.length - 1];
        if (last === undefined) return { ok: false, error: '--no_case follows the --pattern it qualifies' };
        last.noCase = true;
        break;
      }
      default:
        return { ok: false, error: `--${key} is not evaluated by this engine` };
    }
  }
  if (name === undefined || name === '') return { ok: false, error: 'a signature needs --name' };
  if (patterns.length === 0) return { ok: false, error: 'a signature needs at least one --pattern' };
  return { ok: true, signature: Object.freeze({
    name, protocol, service, flow, patterns: Object.freeze(patterns.map(p => Object.freeze(p))),
    destinationPort, sourcePort, severity, defaultAction,
  }) };
}

export interface IpsFlowFacts {
  readonly protocol: 'tcp' | 'udp';
  readonly payload: string;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly fromClient: boolean;
}

interface HttpParts { readonly uri: string; readonly header: string; readonly body: string; readonly host: string }

function httpParts(payload: string): HttpParts | undefined {
  const head = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r?\n/.exec(payload);
  if (head === null) return undefined;
  const separator = payload.search(/\r?\n\r?\n/);
  const headers = separator < 0 ? payload.slice(head[0].length) : payload.slice(head[0].length, separator);
  const body = separator < 0 ? '' : payload.slice(separator).replace(/^\r?\n\r?\n/, '');
  const host = /^host:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? '';
  return { uri: head[2], header: headers, body, host };
}

function haystackOf(context: IpsContext, payload: string): string | undefined {
  if (context === 'packet') return payload;
  const parts = httpParts(payload);
  return parts === undefined ? undefined : parts[context];
}

function patternHits(pattern: IpsPattern, payload: string): boolean {
  const haystack = haystackOf(pattern.context, payload);
  if (haystack === undefined) return false;
  return pattern.noCase
    ? haystack.toLowerCase().includes(pattern.text.toLowerCase())
    : haystack.includes(pattern.text);
}

export function signatureMatches(signature: IpsSignatureBody, facts: IpsFlowFacts): boolean {
  if (signature.protocol !== undefined && signature.protocol !== facts.protocol) return false;
  if (signature.flow === 'from_client' && !facts.fromClient) return false;
  if (signature.flow === 'from_server' && facts.fromClient) return false;
  if (signature.destinationPort !== undefined && signature.destinationPort !== facts.destinationPort) return false;
  if (signature.sourcePort !== undefined && signature.sourcePort !== facts.sourcePort) return false;
  if (signature.service !== undefined) {
    const port = SERVICE_PORTS[signature.service];
    if (port === undefined || (facts.destinationPort !== port && facts.sourcePort !== port)) return false;
  }
  return signature.patterns.every(pattern => patternHits(pattern, facts.payload));
}
