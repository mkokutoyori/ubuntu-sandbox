/**
 * Sonde : l'authenticator (avec son total de controle, sa sous-cle et son numero
 * de sequence), l'AP-REQ, l'AP-REP et sa partie chiffree (EncAPRepPart) du
 * simulateur s'encodent comme ceux de MIT Kerberos : un message reel decode puis
 * reencode redonne les memes octets.
 *
 * Autorite : un vrai `ldapsearch -Y GSSAPI` (OpenLDAP 2.5 avec Cyrus SASL et
 * MIT Kerberos 1.20.1) face a un vrai slapd, a travers un relais qui enregistre
 * chaque PDU (`mit-gssapi-ldap-capture.json`), et le vrai `kvno` face au vrai
 * KDC (`mit-kerberos-kdc-capture.json`). Les messages sont ceux que les deux
 * programmes se sont envoyes ; les parties chiffrees sont ouvertes avec les cles
 * que `kadmin.local ktadd -norandkey` a ecrites (cle de ldap/vm), ce qui fixe aussi
 * les numeros d'usage (2 ticket, 7 et 11 authenticator, 12 EncAPRepPart).
 *
 * Mesure avant correction : le simulateur n'encodait de l'authenticator que le
 * royaume, le nom, la microseconde et l'heure, ne lisait ni total de controle ni
 * sous-cle, et ne connaissait pas l'AP-REP : les 7 cas tombent. Passe avant comme
 * apres : le temoin « la capture est celle d'un echange complet de neuf PDU », qui
 * ne depend d'aucun module du simulateur.
 */
import { describe, expect, it } from 'vitest';
import { parseAll, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import {
  decodeApRep, decodeApReq, decodeAuthenticator, decodeEncApRepPart, decodeEncTicketPart, encodeApRep, encodeApReq,
  encodeAuthenticator, encodeEncApRepPart,
} from '@/network/kerberos/codec';
import { AES256_PROFILE, decrypt } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { AP_OPT_MUTUAL_REQUIRED } from '@/network/kerberos/types';
import { loadJson } from './openldap-replay-support';

interface GssCapture {
  readonly serviceKey: string;
  readonly messages: readonly { dir: string; hex: string }[];
}

const capture = loadJson<GssCapture>('mit-gssapi-ldap-capture.json');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

const KU_TICKET = 2;
const KU_AP_REQ_AUTHENTICATOR = 11;
const KU_AP_REP_ENC_PART = 12;
const GSS_CHECKSUM_TYPE = 0x8003;

function bindCredentials(message: Uint8Array): Uint8Array {
  const bindRequest = parseAll(parseTLV(message, 0).content)[1];
  const sasl = parseAll(bindRequest.content)[2];
  return parseAll(sasl.content)[1].content;
}

function serverCredentials(message: Uint8Array): Uint8Array {
  const bindResponse = parseAll(parseTLV(message, 0).content)[1];
  return parseAll(bindResponse.content).find((field) => field.tagClass === 'context' && field.tagNumber === 7)!.content;
}

function tokenBody(token: Uint8Array, identifierLength: number): Uint8Array {
  const framed = parseTLV(token, 0);
  const oid = parseTLV(framed.content, 0);
  return framed.content.subarray(oid.nextOffset + identifierLength);
}

const apRequestBytes = (): Uint8Array => tokenBody(bindCredentials(bytes(capture.messages[0].hex)), 2);
const apReplyBytes = (): Uint8Array => tokenBody(serverCredentials(bytes(capture.messages[1].hex)), 2);

function serviceTicketSessionKey(): Uint8Array {
  const apReq = decodeApReq(apRequestBytes());
  const part = decodeEncTicketPart(decrypt(AES256_PROFILE, bytes(capture.serviceKey), KU_TICKET, apReq.ticket.encPart.cipher));
  return part.key.keyValue;
}

describe('the AP-REQ, authenticator and AP-REP of a real GSSAPI bind', () => {
  it('the capture is a complete exchange of nine PDU in alternating directions', () => {
    expect(capture.messages.map((message) => message.dir)).toEqual(['c', 's', 'c', 's', 'c', 's', 'c', 's', 'c']);
  });

  it('decodes the AP-REQ, asks for mutual authentication, and reencodes it byte for byte', () => {
    const real = apRequestBytes();
    const decoded = decodeApReq(real);
    expect(decoded.apOptions & AP_OPT_MUTUAL_REQUIRED).not.toBe(0);
    expect(hex(encodeApReq(decoded))).toBe(hex(real));
  });

  it('decodes the authenticator with its GSS-API checksum, subkey and sequence number', () => {
    const decoded = decodeAuthenticator(
      decrypt(AES256_PROFILE, serviceTicketSessionKey(), KU_AP_REQ_AUTHENTICATOR, decodeApReq(apRequestBytes()).authenticator.cipher),
    );
    expect(decoded.crealm).toBe('CORP.LOCAL');
    expect(decoded.cname.nameString).toEqual(['alice']);
    expect(decoded.cksum!.type).toBe(GSS_CHECKSUM_TYPE);
    expect(decoded.cksum!.checksum).toHaveLength(24);
    expect(decoded.subkey!.keyType).toBe(18);
    expect(decoded.subkey!.keyValue).toHaveLength(32);
    expect(decoded.seqNumber).toBeGreaterThan(0);
  });

  it('reencodes the authenticator byte for byte', () => {
    const plaintext = decrypt(
      AES256_PROFILE, serviceTicketSessionKey(), KU_AP_REQ_AUTHENTICATOR, decodeApReq(apRequestBytes()).authenticator.cipher,
    );
    expect(hex(encodeAuthenticator(decodeAuthenticator(plaintext)))).toBe(hex(plaintext));
  });

  it('decodes the AP-REP and reencodes it byte for byte', () => {
    const real = apReplyBytes();
    expect(hex(encodeApRep(decodeApRep(real)))).toBe(hex(real));
  });

  it('opens the encrypted part of the AP-REP, which echoes the time of the authenticator and carries the acceptor subkey', () => {
    const sessionKey = serviceTicketSessionKey();
    const authenticator = decodeAuthenticator(
      decrypt(AES256_PROFILE, sessionKey, KU_AP_REQ_AUTHENTICATOR, decodeApReq(apRequestBytes()).authenticator.cipher),
    );
    const plaintext = decrypt(AES256_PROFILE, sessionKey, KU_AP_REP_ENC_PART, decodeApRep(apReplyBytes()).encPart.cipher);
    const decoded = decodeEncApRepPart(plaintext);
    expect(decoded.ctime).toBe(authenticator.ctime);
    expect(decoded.cusec).toBe(authenticator.cusec);
    expect(decoded.subkey!.keyValue).toHaveLength(32);
    expect(hex(decoded.subkey!.keyValue)).not.toBe(hex(authenticator.subkey!.keyValue));
  });

  it('reencodes the encrypted part of the AP-REP byte for byte', () => {
    const plaintext = decrypt(AES256_PROFILE, serviceTicketSessionKey(), KU_AP_REP_ENC_PART, decodeApRep(apReplyBytes()).encPart.cipher);
    expect(hex(encodeEncApRepPart(decodeEncApRepPart(plaintext)))).toBe(hex(plaintext));
  });
});
