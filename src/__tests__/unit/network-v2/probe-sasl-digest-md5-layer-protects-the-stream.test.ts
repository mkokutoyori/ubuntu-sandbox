/**
 * Sonde : la couche de securite de DIGEST-MD5 (RFC 2831 §2.3, plugins/
 * digestmd5.c de cyrus-sasl 2.1.28) chiffre, signe et numerote le flux entre
 * un client et un serveur qui partagent H(A1). Le rejeu du vrai client ne
 * voit que le sens client vers serveur et les reponses du vrai slapd ; cette
 * sonde ferme l'autre moitie : deux extremites du simulateur dialoguent,
 * et toute alteration est refusee avec le texte de libsasl2.
 *
 * Mesure avant la creation du module : les 9 cas tombent, `digestMd5Layer.ts`
 * n'existe pas. Temoin : « a round trip through both ends returns the
 * message » prouve que le laboratoire (deux extremites, memes cles) est sain
 * avant de lui faire refuser quoi que ce soit.
 */
import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_CIPHERS, DigestSecurityLayer, createLayerKeys, type DigestCipher,
} from '@/network/ldap/openldap/sasl/digest/digestMd5Layer';
import { SaslRc } from '@/network/ldap/openldap/sasl/saslTypes';

const HA1 = new Uint8Array(16).map((_, index) => (index * 37 + 11) & 0xff);
const MAX_RECEIVE = 0xffffff;

interface Pair {
  readonly client: DigestSecurityLayer;
  readonly server: DigestSecurityLayer;
  readonly clientErrors: string[];
  readonly serverErrors: string[];
}

function pairFor(cipher: DigestCipher | null): Pair {
  const clientKeys = createLayerKeys('client', HA1, cipher === null ? 0 : cipher.keyBytes);
  const serverKeys = createLayerKeys('server', HA1, cipher === null ? 0 : cipher.keyBytes);
  const clientErrors: string[] = [];
  const serverErrors: string[] = [];
  const clientPair = cipher === null ? null : cipher.create(clientKeys.encryptionKey, clientKeys.decryptionKey);
  const serverPair = cipher === null ? null : cipher.create(serverKeys.encryptionKey, serverKeys.decryptionKey);
  return {
    client: new DigestSecurityLayer(clientKeys, clientPair, MAX_RECEIVE, (message) => clientErrors.push(message)),
    server: new DigestSecurityLayer(serverKeys, serverPair, MAX_RECEIVE, (message) => serverErrors.push(message)),
    clientErrors,
    serverErrors,
  };
}

const message = new TextEncoder().encode('a search request that must stay private');
const privacyCiphers = AVAILABLE_CIPHERS.filter((cipher) => cipher.name !== '3des');

describe('DIGEST-MD5 security layer', () => {
  it('a round trip through both ends returns the message', () => {
    for (const cipher of [null, ...privacyCiphers]) {
      const { client, server } = pairFor(cipher);
      const sealed = client.encode(message);
      expect(sealed.rc).toBe(SaslRc.OK);
      const opened = server.decode(sealed.data);
      expect(opened.rc).toBe(SaslRc.OK);
      expect(Array.from(opened.data)).toEqual(Array.from(message));
    }
  });

  it('a privacy layer does not carry the message in clear', () => {
    const { client } = pairFor(privacyCiphers[2]);
    const sealed = client.encode(message).data;
    const text = Buffer.from(sealed).toString('latin1');
    expect(text.includes('private')).toBe(false);
  });

  it('an integrity layer carries the message in clear and signs it', () => {
    const { client } = pairFor(null);
    const sealed = client.encode(message).data;
    expect(Buffer.from(sealed).toString('latin1').includes('private')).toBe(true);
    expect(sealed.length).toBe(4 + message.length + 10 + 2 + 4);
  });

  it('a flipped byte is refused with the CMAC message', () => {
    for (const cipher of [null, privacyCiphers[2]]) {
      const { client, server, serverErrors } = pairFor(cipher);
      const sealed = Uint8Array.from(client.encode(message).data);
      sealed[6] ^= 0x01;
      const opened = server.decode(sealed);
      expect(opened.rc).toBe(SaslRc.FAIL);
      expect(serverErrors.some((text) => text.startsWith("CMAC doesn't match at byte "))).toBe(true);
    }
  });

  it('a replayed packet is refused with the sequence message', () => {
    const { client, server, serverErrors } = pairFor(null);
    const first = client.encode(message).data;
    expect(server.decode(first).rc).toBe(SaslRc.OK);
    expect(server.decode(first).rc).toBe(SaslRc.FAIL);
    expect(serverErrors).toContain('Incorrect Sequence Number: received 0, expected 1');
  });

  it('a packet shorter than 16 bytes is refused', () => {
    const { server, serverErrors } = pairFor(null);
    const opened = server.decode(new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]));
    expect(opened.rc).toBe(SaslRc.FAIL);
    expect(serverErrors).toContain('DIGEST-MD5 SASL packets must be at least 16 bytes long');
  });

  it('a wrong protocol version is refused', () => {
    const { client, server, serverErrors } = pairFor(null);
    const sealed = Uint8Array.from(client.encode(message).data);
    sealed[sealed.length - 5] = 2;
    expect(server.decode(sealed).rc).toBe(SaslRc.FAIL);
    expect(serverErrors).toContain('Wrong Version');
  });

  it('two packets in one buffer are both delivered', () => {
    const { client, server } = pairFor(privacyCiphers[0]);
    const first = client.encode(new TextEncoder().encode('one')).data;
    const second = client.encode(new TextEncoder().encode('two')).data;
    const both = new Uint8Array(first.length + second.length);
    both.set(first, 0);
    both.set(second, first.length);
    expect(new TextDecoder().decode(server.decode(both).data)).toBe('onetwo');
  });

  it('a packet split across two reads is reassembled', () => {
    const { client, server } = pairFor(privacyCiphers[1]);
    const sealed = client.encode(message).data;
    expect(server.decode(sealed.subarray(0, 9)).data.length).toBe(0);
    expect(new TextDecoder().decode(server.decode(sealed.subarray(9)).data)).toBe(new TextDecoder().decode(message));
  });
});
