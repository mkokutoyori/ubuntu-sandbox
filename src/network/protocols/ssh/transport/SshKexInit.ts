import { SshReader, SshWriter } from '../wire/SshDataTypes';
import { SSH_MSG_KEXINIT } from './SshMessageNumbers';

export const KEX_COOKIE_LENGTH = 16;

export interface KexProposal {
  readonly kex: readonly string[];
  readonly hostKey: readonly string[];
  readonly encryptionClientToServer: readonly string[];
  readonly encryptionServerToClient: readonly string[];
  readonly macClientToServer: readonly string[];
  readonly macServerToClient: readonly string[];
  readonly compressionClientToServer: readonly string[];
  readonly compressionServerToClient: readonly string[];
  readonly languageClientToServer: readonly string[];
  readonly languageServerToClient: readonly string[];
  readonly firstKexPacketFollows: boolean;
}

export interface KexInit {
  readonly cookie: Uint8Array;
  readonly proposal: KexProposal;
}

const nameList = (names: readonly string[]): string => names.join(',');
const parseNameList = (text: string): string[] => (text === '' ? [] : text.split(','));

export function encodeKexInit(proposal: KexProposal, cookie: Uint8Array): Uint8Array {
  return new SshWriter()
    .writeByte(SSH_MSG_KEXINIT)
    .writeRaw(cookie)
    .writeString(nameList(proposal.kex))
    .writeString(nameList(proposal.hostKey))
    .writeString(nameList(proposal.encryptionClientToServer))
    .writeString(nameList(proposal.encryptionServerToClient))
    .writeString(nameList(proposal.macClientToServer))
    .writeString(nameList(proposal.macServerToClient))
    .writeString(nameList(proposal.compressionClientToServer))
    .writeString(nameList(proposal.compressionServerToClient))
    .writeString(nameList(proposal.languageClientToServer))
    .writeString(nameList(proposal.languageServerToClient))
    .writeByte(proposal.firstKexPacketFollows ? 1 : 0)
    .writeUint32(0)
    .toBytes();
}

export function decodeKexInit(payload: Uint8Array): KexInit | null {
  try {
    const reader = new SshReader(payload);
    if (reader.readByte() !== SSH_MSG_KEXINIT) return null;
    const cookie = reader.readRaw(KEX_COOKIE_LENGTH);
    const lists = Array.from({ length: 10 }, () => parseNameList(reader.readString()));
    const firstKexPacketFollows = reader.readByte() !== 0;
    reader.readUint32();
    return {
      cookie,
      proposal: {
        kex: lists[0],
        hostKey: lists[1],
        encryptionClientToServer: lists[2],
        encryptionServerToClient: lists[3],
        macClientToServer: lists[4],
        macServerToClient: lists[5],
        compressionClientToServer: lists[6],
        compressionServerToClient: lists[7],
        languageClientToServer: lists[8],
        languageServerToClient: lists[9],
        firstKexPacketFollows,
      },
    };
  } catch {
    return null;
  }
}

export interface NegotiatedAlgorithms {
  readonly kex: string;
  readonly hostKey: string;
  readonly encryptionClientToServer: string;
  readonly encryptionServerToClient: string;
  readonly macClientToServer: string | null;
  readonly macServerToClient: string | null;
  readonly compressionClientToServer: string;
  readonly compressionServerToClient: string;
}

export type NegotiationFailure = 'key exchange method' | 'host key type' | 'cipher' | 'MAC' | 'compression method';

export type Negotiation =
  | { readonly ok: true; readonly algorithms: NegotiatedAlgorithms }
  | { readonly ok: false; readonly failure: NegotiationFailure; readonly peerOffer: readonly string[] };

function firstCommon(client: readonly string[], server: readonly string[]): string | null {
  return client.find((name) => server.includes(name)) ?? null;
}

interface DirectionChoice {
  readonly encryption: string;
  readonly mac: string | null;
  readonly compression: string;
}

export function negotiate(
  client: KexProposal, server: KexProposal, role: 'client' | 'server',
  isAead: (cipher: string) => boolean,
): Negotiation {
  const peer = role === 'client' ? server : client;
  const fail = (failure: NegotiationFailure, offer: readonly string[]): Negotiation =>
    ({ ok: false, failure, peerOffer: offer });
  const kex = firstCommon(client.kex, server.kex);
  if (kex === null) return fail('key exchange method', peer.kex);
  const hostKey = firstCommon(client.hostKey, server.hostKey);
  if (hostKey === null) return fail('host key type', peer.hostKey);
  const direction = (clientToServer: boolean): DirectionChoice | Negotiation => {
    const pick = (c: readonly string[], s: readonly string[]): readonly [string | null, readonly string[]] =>
      [firstCommon(c, s), role === 'client' ? s : c];
    const [encryption, encOffer] = clientToServer
      ? pick(client.encryptionClientToServer, server.encryptionClientToServer)
      : pick(client.encryptionServerToClient, server.encryptionServerToClient);
    if (encryption === null) return fail('cipher', encOffer);
    let mac: string | null = null;
    if (!isAead(encryption)) {
      const [chosen, macOffer] = clientToServer
        ? pick(client.macClientToServer, server.macClientToServer)
        : pick(client.macServerToClient, server.macServerToClient);
      if (chosen === null) return fail('MAC', macOffer);
      mac = chosen;
    }
    const [compression, compOffer] = clientToServer
      ? pick(client.compressionClientToServer, server.compressionClientToServer)
      : pick(client.compressionServerToClient, server.compressionServerToClient);
    if (compression === null) return fail('compression method', compOffer);
    return { encryption, mac, compression };
  };
  const incomingIsClientToServer = role === 'server';
  const first = direction(incomingIsClientToServer);
  if ('ok' in first) return first;
  const second = direction(!incomingIsClientToServer);
  if ('ok' in second) return second;
  const [c2s, s2c] = incomingIsClientToServer ? [first, second] : [second, first];
  return {
    ok: true,
    algorithms: {
      kex,
      hostKey,
      encryptionClientToServer: c2s.encryption,
      encryptionServerToClient: s2c.encryption,
      macClientToServer: c2s.mac,
      macServerToClient: s2c.mac,
      compressionClientToServer: c2s.compression,
      compressionServerToClient: s2c.compression,
    },
  };
}
