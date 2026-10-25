import { IPAddress, IPv6Address } from '@/network/core/types';
import { PortNumber } from '@/network/core/ports/PortNumber';

const DNS_PORT = 53;
const DNS_OVER_TLS_PORT = 853;

export interface DnsServerWord {
  readonly address: string;
  readonly port: number;
  readonly interfaceName: string | null;
  readonly serverName: string | null;
}

function parseAddress(text: string): { address: string; family: 4 | 6 } | null {
  if (text.includes(':')) {
    try {
      return { address: new IPv6Address(text).toString(), family: 6 };
    } catch {
      return null;
    }
  }
  try {
    return { address: new IPAddress(text).toString(), family: 4 };
  } catch {
    return null;
  }
}

function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && PortNumber.isValid(value) ? value : null;
}

export function parseDnsServerWord(word: string): DnsServerWord | null {
  let rest = word;
  let serverName: string | null = null;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    serverName = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (serverName === '') return null;
  }
  let interfaceName: string | null = null;
  let addressText: string;
  let portText: string | null = null;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return null;
    addressText = rest.slice(1, close);
    let tail = rest.slice(close + 1);
    const tailPercent = tail.indexOf('%');
    if (tailPercent >= 0) {
      interfaceName = tail.slice(tailPercent + 1);
      tail = tail.slice(0, tailPercent);
    }
    if (tail.startsWith(':')) portText = tail.slice(1);
    else if (tail !== '') return null;
    const percent = addressText.indexOf('%');
    if (percent >= 0) {
      interfaceName = addressText.slice(percent + 1);
      addressText = addressText.slice(0, percent);
    }
  } else {
    const percent = rest.indexOf('%');
    if (percent >= 0) {
      interfaceName = rest.slice(percent + 1);
      rest = rest.slice(0, percent);
    }
    const colons = rest.split(':').length - 1;
    if (colons === 1) {
      addressText = rest.slice(0, rest.indexOf(':'));
      portText = rest.slice(rest.indexOf(':') + 1);
    } else addressText = rest;
  }
  if (interfaceName === '') return null;
  const parsed = parseAddress(addressText);
  if (parsed === null) return null;
  let port = 0;
  if (portText !== null) {
    const value = parsePort(portText);
    if (value === null) return null;
    port = value === DNS_PORT || value === DNS_OVER_TLS_PORT ? 0 : value;
  }
  return { address: parsed.address, port, interfaceName, serverName };
}

export function formatDnsServerWord(server: DnsServerWord): string {
  const bracket = server.address.includes(':') && server.port !== 0;
  let text = bracket ? `[${server.address}]` : server.address;
  if (server.port !== 0) text += `:${server.port}`;
  if (server.interfaceName !== null) text += `%${server.interfaceName}`;
  if (server.serverName !== null) text += `#${server.serverName}`;
  return text;
}

export function isLoopbackServer(word: string): boolean {
  const parsed = parseDnsServerWord(word);
  return parsed !== null && (parsed.address.startsWith('127.') || parsed.address === '::1');
}
