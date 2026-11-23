import { IPAddress } from '@/network/core/types';
import type { RadSecTls } from '@/network/radius/RadSecTlsPolicy';
import { readTlsBody } from './RadSecTlsSection';
import type { ClientProtocol, MessageAuthenticatorPolicy, RadiusClientEntry } from '@/network/radius/ClientTable';
import { parseFreeradiusConf, type ConfFileReader, type ConfSection } from './FreeradiusConf';

export interface ParsedClients {
  readonly clients: RadiusClientEntry[];
  readonly errors: string[];
  readonly warnings: string[];
}

const POLICIES = new Set(['yes', 'no', 'auto', 'true', 'false']);

function policyOf(value: string | undefined): MessageAuthenticatorPolicy {
  if (value === undefined) return 'auto';
  if (value === 'true') return 'yes';
  if (value === 'false') return 'no';
  return value as MessageAuthenticatorPolicy;
}

function renderSection(section: ConfSection, indent: number): string[] {
  const tabs = '\t'.repeat(indent);
  const lines = [section.name2 === null ? `${tabs}${section.name1} {` : `${tabs}${section.name1} ${section.name2} {`];
  for (const item of section.items) {
    if ('items' in item) lines.push(...renderSection(item, indent + 1));
    else lines.push(item.value === '' ? `${tabs}\t${item.name}` : `${tabs}\t${item.name} = ${item.value}`);
  }
  lines.push(`${tabs}}`);
  return lines;
}

function pair(section: ConfSection, name: string): string | undefined {
  return section.pairs.find((candidate) => candidate.name === name)?.value;
}

function parseAddressSpec(text: string, netmask: number | null): { address: IPAddress; prefix: number } | null {
  const slash = text.indexOf('/');
  const address = IPAddress.tryParse(slash === -1 ? text : text.slice(0, slash));
  if (address === null) return null;
  if (slash === -1) return { address, prefix: netmask ?? 32 };
  const prefix = Number(text.slice(slash + 1));
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 ? { address, prefix } : null;
}

export function readClientSections(sections: readonly ConfSection[], result: ParsedClients): void {
  for (const section of sections) {
    if (section.name1 !== 'client') continue;
    const where = `${section.file}[${section.line}]`;
    const name2 = section.name2 ?? '';
    const explicit = pair(section, 'ipaddr') ?? pair(section, 'ipv4addr') ?? pair(section, 'ipv6addr');
    const netmaskText = pair(section, 'netmask');
    const netmask = netmaskText === undefined ? null : Number(netmaskText);
    let spec: { address: IPAddress; prefix: number } | null;
    let longname: string;
    if (explicit !== undefined) {
      spec = parseAddressSpec(explicit, netmask);
      longname = explicit;
      if (spec === null) {
        result.errors.push(`${where}: Failed parsing client address "${explicit}"`);
        continue;
      }
    } else {
      result.warnings.push(`${where}: No 'ipaddr' or 'ipv4addr' or 'ipv6addr' field found in client ${name2}. Please fix your configuration`);
      result.warnings.push(`${where}: Support for old-style clients will be removed in a future release`);
      spec = parseAddressSpec(name2, netmask);
      longname = name2;
      if (spec === null) {
        result.errors.push(`${where}: Failed parsing client name "${name2}" as ip address or hostname`);
        continue;
      }
    }
    const protoText = pair(section, 'proto');
    const protoKinds: Record<string, { protocol: ClientProtocol; tls: boolean }> = {
      udp: { protocol: 'udp', tls: false }, tcp: { protocol: 'tcp', tls: false }, tls: { protocol: 'tcp', tls: true },
      radsec: { protocol: 'tcp', tls: true }, '*': { protocol: '*', tls: false },
    };
    if (protoText !== undefined && protoKinds[protoText] === undefined) {
      result.errors.push(`${where}: Unknown proto "${protoText}".`);
      continue;
    }
    const kind = protoText === undefined ? protoKinds.udp : protoKinds[protoText];
    const tlsSection = section.sections.find((candidate) => candidate.name1 === 'tls');
    const tlsRead = tlsSection === undefined ? null : readTlsBody(tlsSection);
    if (tlsRead !== null && 'error' in tlsRead) {
      result.errors.push(tlsRead.error);
      continue;
    }
    const tls: RadSecTls | undefined = tlsRead !== null && !('error' in tlsRead) ? tlsRead : undefined;
    const secret = pair(section, 'secret') ?? (kind.tls ? 'radsec' : '');
    if (secret === '') {
      result.errors.push(`${where}: secret must be at least 1 character long`);
      continue;
    }
    const requireMa = pair(section, 'require_message_authenticator');
    if (requireMa !== undefined && !POLICIES.has(requireMa)) {
      result.errors.push(`${where}: Invalid value "${requireMa}" for require_message_authenticator`);
      continue;
    }
    if (secret.length < 12) {
      result.warnings.push(`${where}: Shared secret for client ${name2} is short, and likely can be broken by an attacker.`);
    }
    result.clients.push({
      name: longname,
      shortname: pair(section, 'shortname') ?? name2,
      section: name2,
      confLines: renderSection(section, 0),
      address: spec.address,
      prefix: spec.prefix,
      secret,
      nasType: pair(section, 'nas_type') ?? 'other',
      requireMessageAuthenticator: policyOf(requireMa),
      limitProxyState: policyOf(pair(section, 'limit_proxy_state')),
      protocol: kind.protocol,
      tlsRequired: kind.tls,
      ...(tls === undefined ? {} : { tls }),
    });
  }
}

export function parseClientsConf(source: string, fileName: string, readFile: ConfFileReader = () => null): ParsedClients {
  const result: ParsedClients = { clients: [], errors: [], warnings: [] };
  const parsed = parseFreeradiusConf(source, fileName, readFile);
  if ('error' in parsed) {
    result.errors.push(parsed.error);
    return result;
  }
  readClientSections(parsed.root.sections, result);
  if (result.clients.length === 0 && result.errors.length === 0) {
    result.errors.push(`${fileName}: No "client" section found in client file`);
  }
  return result;
}
