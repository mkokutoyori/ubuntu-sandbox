import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

export interface ConnectAddress {
  readonly host: string;
  readonly port: number;
}

export interface ConnectDescriptor {
  readonly addresses: readonly ConnectAddress[];
  readonly service: string;
  readonly failoverEnabled: boolean;
  readonly programName?: string;
  readonly hostName?: string;
  readonly userName?: string;
}

export function findBalancedGroups(text: string, key: string): string[] {
  const results: string[] = [];
  const startRe = new RegExp(`\\(\\s*${key}\\s*=`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(text)) !== null) {
    const start = match.index;
    let depth = 0;
    let index = start;
    for (; index < text.length; index++) {
      if (text[index] === '(') depth++;
      else if (text[index] === ')') {
        depth--;
        if (depth === 0) { index++; break; }
      }
    }
    results.push(text.slice(start + 1, index - 1));
    startRe.lastIndex = index;
  }
  return results;
}

export function readKeyword(text: string, keyword: string): string | undefined {
  return new RegExp(`\\(\\s*${keyword}\\s*=\\s*([^)\\s]+)\\s*\\)`, 'i').exec(text)?.[1];
}

export function readConnectAddresses(text: string): ConnectAddress[] {
  const addresses: ConnectAddress[] = [];
  for (const body of findBalancedGroups(text, 'ADDRESS')) {
    const host = readKeyword(body, 'HOST');
    const port = readKeyword(body, 'PORT');
    if (host) {
      addresses.push({
        host,
        port: port !== undefined ? Number.parseInt(port, 10) : ORACLE_CONFIG.PORT,
      });
    }
  }
  return addresses;
}

export function readRequestedService(text: string): string | undefined {
  const connectData = findBalancedGroups(text, 'CONNECT_DATA')[0] ?? text;
  const service = readKeyword(connectData, 'SERVICE_NAME') ?? readKeyword(connectData, 'SID');
  return service?.toUpperCase();
}

export function parseConnectDescriptor(text: string): ConnectDescriptor | null {
  const addresses = readConnectAddresses(text);
  if (addresses.length === 0) return null;
  const connectData = findBalancedGroups(text, 'CONNECT_DATA')[0] ?? text;
  const clientInfo = findBalancedGroups(connectData, 'CID')[0] ?? '';
  return {
    addresses,
    service: readRequestedService(text) ?? ORACLE_CONFIG.SID,
    failoverEnabled: /\(\s*FAILOVER\s*=\s*ON\s*\)/i.test(text) || /FAILOVER_MODE/i.test(text),
    programName: readKeyword(clientInfo, 'PROGRAM'),
    hostName: readKeyword(clientInfo, 'HOST'),
    userName: readKeyword(clientInfo, 'USER'),
  };
}

export interface ConnectDescriptorRequest {
  readonly host: string;
  readonly port: number;
  readonly service: string;
  readonly programName: string;
  readonly hostName: string;
  readonly userName: string;
}

export function renderConnectDescriptor(request: ConnectDescriptorRequest): string {
  return '(DESCRIPTION='
    + `(ADDRESS=(PROTOCOL=TCP)(HOST=${request.host})(PORT=${request.port}))`
    + '(CONNECT_DATA='
    + `(SERVICE_NAME=${request.service})`
    + `(CID=(PROGRAM=${request.programName})(HOST=${request.hostName})(USER=${request.userName}))`
    + '))';
}
