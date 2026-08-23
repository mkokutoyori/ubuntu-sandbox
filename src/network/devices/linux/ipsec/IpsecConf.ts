export interface IpsecConn {
  readonly name: string;
  readonly settings: ReadonlyMap<string, string>;
}

export interface IpsecConfFile {
  readonly setup: ReadonlyMap<string, string>;
  readonly conns: readonly IpsecConn[];
}

const DEFAULT_CONN = '%default';

function sectionHeader(line: string): { kind: 'config' | 'conn'; name: string } | null {
  const words = line.trim().split(/\s+/);
  if (words.length < 2) return null;
  if (words[0] === 'config' && words[1] === 'setup') return { kind: 'config', name: 'setup' };
  if (words[0] === 'conn') return { kind: 'conn', name: words[1] };
  return null;
}

export function parseIpsecConf(text: string): IpsecConfFile {
  const setup = new Map<string, string>();
  const sections = new Map<string, Map<string, string>>();
  const order: string[] = [];
  let current: Map<string, string> | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    if (line.trim().length === 0) continue;

    const header = sectionHeader(line);
    if (header && !/^\s/.test(line)) {
      if (header.kind === 'config') { current = setup; continue; }
      let section = sections.get(header.name);
      if (!section) {
        section = new Map();
        sections.set(header.name, section);
        order.push(header.name);
      }
      current = section;
      continue;
    }

    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0) current.set(key, value);
  }

  const defaults = sections.get(DEFAULT_CONN) ?? new Map<string, string>();
  const conns = order
    .filter(name => name !== DEFAULT_CONN)
    .map(name => {
      const merged = new Map(defaults);
      for (const [k, v] of sections.get(name) ?? []) merged.set(k, v);
      return { name, settings: merged };
    });

  return { setup, conns };
}

export interface IpsecSecret {
  readonly selectors: readonly string[];
  readonly kind: string;
  readonly secret: string;
}

export function parseIpsecSecrets(text: string): IpsecSecret[] {
  const out: IpsecSecret[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const selectors = line.slice(0, colon).trim().split(/\s+/).filter(w => w.length > 0);
    const rest = line.slice(colon + 1).trim().split(/\s+/);
    const kind = (rest[0] ?? '').toUpperCase();
    const secret = rest.slice(1).join(' ').replace(/^"|"$/g, '');
    out.push({ selectors, kind, secret });
  }
  return out;
}

export function secretFor(
  secrets: readonly IpsecSecret[], local: string, remote: string,
): string | null {
  const matches = (selector: string, address: string) =>
    selector === '%any' || selector === address;
  for (const entry of secrets) {
    if (entry.kind !== 'PSK') continue;
    if (entry.selectors.length === 0) return entry.secret;
    const covered = entry.selectors.some(s => matches(s, local))
      && entry.selectors.some(s => matches(s, remote));
    if (covered) return entry.secret;
  }
  return null;
}

export function ikeVersionOf(conn: IpsecConn): 'IKEv1' | 'IKEv2' {
  const value = (conn.settings.get('keyexchange') ?? 'ikev2').toLowerCase();
  return value === 'ikev1' ? 'IKEv1' : 'IKEv2';
}

export function authClassOf(conn: IpsecConn, side: 'left' | 'right'): string {
  const explicit = conn.settings.get(`${side}auth`);
  if (explicit) {
    const value = explicit.toLowerCase();
    if (value === 'psk' || value === 'secret') return 'pre-shared key';
    if (value === 'pubkey' || value === 'rsasig') return 'public key';
    if (value.startsWith('eap')) return 'EAP';
    return value;
  }
  const authby = (conn.settings.get('authby') ?? 'secret').toLowerCase();
  return authby === 'secret' || authby === 'psk' ? 'pre-shared key' : 'public key';
}
