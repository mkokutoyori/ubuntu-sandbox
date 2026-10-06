/**
 * Sonde : le chiffrement Kerberos aes128/aes256-cts-hmac-sha1-96 (RFC 3961
 * profil simplifie, RFC 3962) du simulateur est celui de libk5crypto : les
 * cles derivees d'un mot de passe, le chiffrement par vol de texte chiffre
 * (CBC-CS3), la cle de chiffrement Ke et la cle d'integrite Ki par usage, le
 * HMAC-SHA1 tronque a 12 octets.
 *
 * Autorite : un vrai krb5kdc (MIT 1.20.1, royaume CORP.LOCAL) et le vrai
 * `kinit` / `kvno`, a travers un relais qui enregistre chaque message sur
 * TCP/88 (`mit-kerberos-kdc-capture.json`) ; les cles de longue duree sont
 * celles que `kadmin.local ktadd -norandkey` ecrit puis que `klist -K`
 * affiche (bob, alice, krbtgt, ldap/vm). Les messages (AS-REQ avec
 * PA-ENC-TIMESTAMP, KRB-ERROR, AS-REP, TGS-REQ, TGS-REP, tickets) sont ceux
 * que le vrai client et le vrai KDC se sont echanges.
 *
 * Ce que la capture prouve : un message dechiffre ici ne passe la verification
 * du HMAC que si la cle derivee, le CBC-CS3 et la cle d'integrite sont ceux de
 * MIT ; rechiffre avec le confounder d'origine, il redonne les memes octets, ce
 * qui fixe aussi le sens du chiffrement (alignement, ordre des deux derniers
 * blocs, troncature du HMAC).
 *
 * Limite : le TGS-REQ du vrai client est blinde par FAST (RFC 6113, padata
 * PA-FX-FAST) parce que le KDC l'annonce (`fast_avail` dans le cache) ; sa
 * reponse est chiffree par la cle de reponse renforcee de FAST, que ce
 * module ne derive pas. Les tickets, l'authenticator et son total de controle
 * sont verifies ; la partie chiffree de la reponse du TGS ne l'est pas.
 *
 * Mesure avant la creation des modules : `nFold`, `aesCtsEncrypt` et le profil
 * `aesCtsHmacSha1` n'existaient pas, les 26 cas tombent (le simulateur
 * chiffrait par un flux XOR sur un condense). Aucun cas ne passe avant.
 */
import { describe, expect, it } from 'vitest';
import { encodeTLV, parseAll, parseTLV, type BerNode } from '@/network/devices/windows/server/ad/ldap/Ber';
import { aesCtsDecrypt, aesCtsEncrypt } from '@/crypto/cipher';
import { nFold } from '@/crypto/kdf';
import {
  AES128_CTS_HMAC_SHA1_96, AES256_CTS_HMAC_SHA1_96, KerberosIntegrityError, checksum, decrypt,
  decryptWithConfounder, deriveKey, encrypt, stringToKey, type AesProfile,
} from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { loadJson } from './openldap-replay-support';

interface Capture {
  readonly keys: Readonly<Record<string, string>>;
  readonly stringToKey: readonly { password: string; salt: string; aes256: string; aes128: string }[];
  readonly asExchange: readonly string[];
  readonly tgsExchange: readonly string[];
}

const capture = loadJson<Capture>('mit-kerberos-kdc-capture.json');

const KU_PA_ENC_TIMESTAMP = 1;
const KU_TICKET = 2;
const KU_AS_REP_ENC_PART = 3;
const KU_TGS_REQ_AUTHENTICATOR = 7;
const KU_TGS_REQ_AUTH_CKSUM = 6;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const key = (name: string): Uint8Array => bytes(capture.keys[name]);

function explicit(node: BerNode, tagNumber: number): BerNode {
  const wrapper = parseAll(node.content).find((child) => child.tagClass === 'context' && child.tagNumber === tagNumber);
  if (wrapper === undefined) throw new Error(`no [${tagNumber}] field`);
  return parseTLV(wrapper.content, 0);
}

function applicationTagOf(text: string): number {
  return parseTLV(bytes(text), 0).tagNumber;
}

function body(application: BerNode): BerNode {
  return parseTLV(application.content, 0);
}

function message(text: string): BerNode {
  return body(parseTLV(bytes(text), 0));
}

function encryptedDataOf(node: BerNode): { etype: number; cipher: Uint8Array } {
  return {
    etype: Number(BigInt(`0x${hex(explicit(node, 0).content)}`)),
    cipher: explicit(node, 2).content,
  };
}

function sessionKeyOf(encryptionKey: BerNode): Uint8Array {
  return explicit(encryptionKey, 1).content;
}

function roundTrips(profile: AesProfile, longTermKey: Uint8Array, usage: number, ciphertext: Uint8Array): Uint8Array {
  const opened = decryptWithConfounder(profile, longTermKey, usage, ciphertext);
  const sealed = encrypt(profile, longTermKey, usage, opened.plaintext, () => opened.confounder);
  expect(hex(sealed)).toBe(hex(ciphertext));
  return opened.plaintext;
}

describe('n-fold (RFC 3961 section 5.1)', () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  it('folds "012345" to 64 bits', () => {
    expect(hex(nFold(text('012345'), 8))).toBe('be072631276b1955');
  });

  it('folds "password" to 56 bits', () => {
    expect(hex(nFold(text('password'), 7))).toBe('78a07b6caf85fa');
  });

  it('folds "Rough Consensus, and Running Code" to 64 bits', () => {
    expect(hex(nFold(text('Rough Consensus, and Running Code'), 8))).toBe('bb6ed30870b7f0e0');
  });

  it('folds "kerberos" to 64 bits', () => {
    expect(hex(nFold(text('kerberos'), 8))).toBe('6b65726265726f73');
  });
});

describe('AES-CTS (CBC-CS3) round trips', () => {
  const aesKey = bytes('636869636b656e207465726979616b69');
  const iv = new Uint8Array(16);

  it('keeps every length from one block to five blocks', () => {
    for (let length = 16; length <= 80; length++) {
      const plain = Uint8Array.from({ length }, (_, index) => (index * 7 + length) & 0xff);
      expect(hex(aesCtsDecrypt(aesKey, iv, aesCtsEncrypt(aesKey, iv, plain)))).toBe(hex(plain));
    }
  });

  it('refuses less than one block', () => {
    expect(() => aesCtsEncrypt(aesKey, iv, new Uint8Array(15))).toThrow();
  });
});

describe('string-to-key matches the keys the real KDC stores', () => {
  it.each(capture.stringToKey)('aes256 for $password with salt $salt', (vector) => {
    expect(hex(stringToKey(AES256_CTS_HMAC_SHA1_96, vector.password, vector.salt))).toBe(vector.aes256);
  });

  it.each(capture.stringToKey)('aes128 for $password with salt $salt', (vector) => {
    expect(hex(stringToKey(AES128_CTS_HMAC_SHA1_96, vector.password, vector.salt))).toBe(vector.aes128);
  });

  it('a different salt gives a different key', () => {
    const vector = capture.stringToKey[0];
    expect(hex(stringToKey(AES256_CTS_HMAC_SHA1_96, vector.password, `${vector.salt}x`))).not.toBe(vector.aes256);
  });
});

describe('the real authentication-service exchange of bob', () => {
  const [firstRequest, preauthRequired, secondRequest, reply] = capture.asExchange.map(message);
  const profile = AES256_CTS_HMAC_SHA1_96;

  it('the lab is sound: the captured exchange has the four messages of RFC 4120 in order', () => {
    expect(capture.asExchange.map(applicationTagOf)).toEqual([10, 30, 10, 11]);
    expect(firstRequest.constructed).toBe(true);
    expect(secondRequest.constructed).toBe(true);
  });

  it('decrypts the PA-ENC-TIMESTAMP with the key derived from the password and rebuilds it byte for byte', () => {
    const padata = parseAll(explicit(secondRequest, 3).content)
      .map((entry) => ({ type: Number(BigInt(`0x${hex(explicit(entry, 1).content)}`)), value: explicit(entry, 2).content }))
      .find((entry) => entry.type === 2);
    expect(padata).toBeDefined();
    const encrypted = encryptedDataOf(parseTLV(padata!.value, 0));
    expect(encrypted.etype).toBe(18);
    const plaintext = roundTrips(profile, stringToKey(profile, 'bobpw', 'CORP.LOCALbob'), KU_PA_ENC_TIMESTAMP, encrypted.cipher);
    expect(plaintext[0]).toBe(0x30);
  });

  it('the KRB-ERROR announces the pre-authentication the client then supplied', () => {
    const errorCode = Number(BigInt(`0x${hex(explicit(preauthRequired, 6).content)}`));
    expect(errorCode).toBe(25);
  });

  it('decrypts the AS-REP with the long-term key and rebuilds it byte for byte', () => {
    const encrypted = encryptedDataOf(explicit(reply, 6));
    const plaintext = roundTrips(profile, key('bob-aes256'), KU_AS_REP_ENC_PART, encrypted.cipher);
    const body = parseTLV(parseTLV(plaintext, 0).content, 0);
    expect(sessionKeyOf(explicit(body, 0))).toHaveLength(32);
  });

  it('decrypts the ticket with the krbtgt key and finds the same session key as the client received', () => {
    const encryptedReply = encryptedDataOf(explicit(reply, 6));
    const replyPart = parseTLV(parseTLV(decrypt(profile, key('bob-aes256'), KU_AS_REP_ENC_PART, encryptedReply.cipher), 0).content, 0);
    const ticket = body(explicit(reply, 5));
    const ticketPlain = roundTrips(profile, key('krbtgt-aes256'), KU_TICKET, encryptedDataOf(explicit(ticket, 3)).cipher);
    const ticketPart = parseTLV(parseTLV(ticketPlain, 0).content, 0);
    expect(hex(sessionKeyOf(explicit(ticketPart, 1)))).toBe(hex(sessionKeyOf(explicit(replyPart, 0))));
  });

  it('the long-term keys of the two realms principals are not interchangeable', () => {
    const encrypted = encryptedDataOf(explicit(reply, 6));
    expect(() => decrypt(profile, key('alice-aes256'), KU_AS_REP_ENC_PART, encrypted.cipher)).toThrow(KerberosIntegrityError);
  });

  it('refuses a ciphertext whose last byte was altered', () => {
    const encrypted = encryptedDataOf(explicit(reply, 6));
    const altered = encrypted.cipher.slice();
    altered[altered.length - 1] ^= 1;
    expect(() => decrypt(profile, key('bob-aes256'), KU_AS_REP_ENC_PART, altered)).toThrow(KerberosIntegrityError);
  });

  it('refuses a ciphertext decrypted under another key usage', () => {
    const encrypted = encryptedDataOf(explicit(reply, 6));
    expect(() => decrypt(profile, key('bob-aes256'), KU_PA_ENC_TIMESTAMP, encrypted.cipher)).toThrow(KerberosIntegrityError);
  });
});

describe('the real ticket-granting exchange for ldap/vm', () => {
  const [request, reply] = capture.tgsExchange.map(message);
  const profile = AES256_CTS_HMAC_SHA1_96;

  function sessionKeyOfTicketGrantingTicket(): Uint8Array {
    const [, , , asReply] = capture.asExchange.map(message);
    const sealed = encryptedDataOf(explicit(asReply, 6)).cipher;
    const part = parseTLV(parseTLV(decrypt(profile, key('bob-aes256'), KU_AS_REP_ENC_PART, sealed), 0).content, 0);
    return sessionKeyOf(explicit(part, 0));
  }

  function apRequest(): BerNode {
    const padata = parseAll(explicit(request, 3).content)
      .map((entry) => ({ type: Number(BigInt(`0x${hex(explicit(entry, 1).content)}`)), value: explicit(entry, 2).content }))
      .find((entry) => entry.type === 1)!;
    return parseTLV(parseTLV(padata.value, 0).content, 0);
  }

  it('decrypts the authenticator with the session key and rebuilds it byte for byte', () => {
    const encrypted = encryptedDataOf(explicit(apRequest(), 4));
    const plaintext = roundTrips(profile, sessionKeyOfTicketGrantingTicket(), KU_TGS_REQ_AUTHENTICATOR, encrypted.cipher);
    expect(plaintext[0]).toBe(0x62);
  });

  it('decrypts the presented ticket with the krbtgt key', () => {
    const ticket = body(explicit(apRequest(), 3));
    const plaintext = roundTrips(profile, key('krbtgt-aes256'), KU_TICKET, encryptedDataOf(explicit(ticket, 3)).cipher);
    expect(plaintext[0]).toBe(0x63);
  });

  it('decrypts the service ticket with the key of ldap/vm and rebuilds it byte for byte', () => {
    const ticket = body(explicit(reply, 5));
    const plaintext = roundTrips(profile, key('ldap-vm-aes256'), KU_TICKET, encryptedDataOf(explicit(ticket, 3)).cipher);
    expect(plaintext[0]).toBe(0x63);
  });

  it('the checksum of the request body in the authenticator is the one the real client computed', () => {
    const authenticatorPlain = decrypt(
      profile, sessionKeyOfTicketGrantingTicket(), KU_TGS_REQ_AUTHENTICATOR, encryptedDataOf(explicit(apRequest(), 4)).cipher,
    );
    const authenticator = body(parseTLV(authenticatorPlain, 0));
    const announced = explicit(explicit(authenticator, 3), 1).content;
    const requestBody = encodeTLV('universal', 0x10, true, explicit(request, 4).content);
    expect(hex(checksum(profile, sessionKeyOfTicketGrantingTicket(), KU_TGS_REQ_AUTH_CKSUM, requestBody))).toBe(hex(announced));
  });

  it('the authenticator announces a subkey of the length of the session key', () => {
    const authenticatorPlain = decrypt(
      profile, sessionKeyOfTicketGrantingTicket(), KU_TGS_REQ_AUTHENTICATOR, encryptedDataOf(explicit(apRequest(), 4)).cipher,
    );
    expect(sessionKeyOf(explicit(body(parseTLV(authenticatorPlain, 0)), 6))).toHaveLength(32);
  });
});

describe('derived keys and checksums', () => {
  it('derives distinct keys per constant and keeps the key length', () => {
    const base = key('bob-aes256');
    const first = deriveKey(AES256_CTS_HMAC_SHA1_96, base, new TextEncoder().encode('one'));
    const second = deriveKey(AES256_CTS_HMAC_SHA1_96, base, new TextEncoder().encode('two'));
    expect(first).toHaveLength(32);
    expect(hex(first)).not.toBe(hex(second));
  });

  it('a checksum is twelve octets and depends on the key usage', () => {
    const data = new TextEncoder().encode('message');
    const one = checksum(AES256_CTS_HMAC_SHA1_96, key('bob-aes256'), 25, data);
    const two = checksum(AES256_CTS_HMAC_SHA1_96, key('bob-aes256'), 23, data);
    expect(one).toHaveLength(12);
    expect(hex(one)).not.toBe(hex(two));
  });
});
