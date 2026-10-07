import { decodeTicket, encodeTicket, ticketFlagsFromBits, ticketFlagsToBits } from '@/network/kerberos/codec';
import type { AsExchangeResult } from '@/network/kerberos/KerberosClient';
import type { PrincipalName, Ticket } from '@/network/kerberos/types';
import {
  decodeCcache, encodeCcache, type Ccache, type CcacheCredential, type CcachePrincipal,
} from '@/network/kerberos/ccache/FileCcache';
import type { Krb5Host } from './Krb5Host';
import type { Krb5Principal } from './Krb5Principal';

export interface CcacheName {
  readonly type: string;
  readonly residual: string;
}

export function parseCcacheName(name: string): CcacheName {
  const match = /^([A-Za-z][A-Za-z0-9]+):(.*)$/.exec(name);
  if (match !== null && match[1].length > 1) return { type: match[1].toUpperCase(), residual: match[2] };
  return { type: 'FILE', residual: name };
}

export function ccachePathOf(name: CcacheName): string | null {
  return name.type === 'FILE' ? name.residual : null;
}

export function toCcachePrincipal(principal: Krb5Principal): CcachePrincipal {
  return { nameType: principal.nameType, realm: principal.realm, components: principal.components };
}

export function fromCcachePrincipal(principal: CcachePrincipal): Krb5Principal {
  return { nameType: principal.nameType, realm: principal.realm, components: principal.components };
}

export function ccachePrincipalOfName(name: PrincipalName, realm: string): CcachePrincipal {
  return { nameType: name.nameType, realm, components: name.nameString };
}

export function credentialFromExchange(client: Krb5Principal, exchange: AsExchangeResult): CcacheCredential | null {
  const ticket = exchange.ticket;
  const part = exchange.encKdcRepPart;
  if (!exchange.ok || ticket === undefined || part === undefined) return null;
  const startTime = part.starttime ?? part.authtime;
  return {
    client: toCcachePrincipal(client),
    server: ccachePrincipalOfName(part.sname, part.srealm),
    keyType: part.key.keyType,
    key: part.key.keyValue,
    authTime: part.authtime,
    startTime,
    endTime: part.endtime,
    renewTill: part.renewTill ?? 0,
    isSessionKey: false,
    flags: ticketFlagsToBits(part.flags),
    addresses: [],
    authData: [],
    ticket: encodeTicket(ticket),
    secondTicket: new Uint8Array(0),
  };
}

export function ticketOfCredential(credential: CcacheCredential): Ticket | null {
  try {
    return decodeTicket(credential.ticket);
  } catch {
    return null;
  }
}

export function flagsOfCredential(credential: CcacheCredential) {
  return ticketFlagsFromBits(credential.flags);
}

export function isConfigurationCredential(credential: CcacheCredential): boolean {
  return credential.server.realm === 'X-CACHECONF:';
}

export class FileCredentialCache {
  constructor(private readonly host: Krb5Host, readonly path: string) {}

  exists(): boolean {
    return this.host.fileExists(this.path);
  }

  read(): Ccache | null {
    const bytes = this.host.readBytes(this.path);
    return bytes === null ? null : decodeCcache(bytes);
  }

  write(cache: Ccache): boolean {
    return this.host.writeBytes(this.path, encodeCcache(cache));
  }

  destroy(): boolean {
    return this.host.removeFile(this.path);
  }
}

