/**
 * Minimal `clients.conf` parser — just enough of freeradius's `client { }`
 * block syntax to drive `RadiusdService`: a name/IP, an optional `ipaddr`,
 * and the `secret`. Real freeradius clients.conf supports far more
 * (nested sub-blocks, `require_message_authenticator`, per-client
 * `nas_type`, …) — out of scope here, matching PRD-RADIUS §2.2's framing
 * of this as "clients.conf, users, radtest" rather than a full freeradius
 * config-language implementation.
 */

export interface ParsedClient {
  name: string;
  ipaddr: string | null;
  secret: string;
}

const CLIENT_BLOCK = /client\s+(\S+)\s*\{([^}]*)\}/g;

export function parseClientsConf(source: string): ParsedClient[] {
  const clients: ParsedClient[] = [];
  const stripped = source
    .split('\n')
    .map((line) => line.split('#')[0])
    .join('\n');

  let m: RegExpExecArray | null;
  CLIENT_BLOCK.lastIndex = 0;
  while ((m = CLIENT_BLOCK.exec(stripped))) {
    const name = m[1];
    const body = m[2];
    const secretMatch = /secret\s*=\s*("[^"]*"|\S+)/.exec(body);
    if (!secretMatch) continue;
    const ipMatch = /ipaddr\s*=\s*("[^"]*"|\S+)/.exec(body);
    const ipaddr = ipMatch ? unquote(ipMatch[1]) : (isDottedQuad(name) ? name : null);
    clients.push({ name, ipaddr, secret: unquote(secretMatch[1]) });
  }
  return clients;
}

function unquote(s: string): string {
  return s.replace(/^"(.*)"$/, '$1');
}

function isDottedQuad(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}
