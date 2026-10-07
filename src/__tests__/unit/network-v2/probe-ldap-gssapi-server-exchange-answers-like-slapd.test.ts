/**
 * Sonde : le cote serveur de l'echange SASL GSSAPI (RFC 4752) du simulateur
 * repond au vrai `ldapsearch` comme le vrai slapd : le jeton AP-REP, l'offre de
 * couches enveloppee et la lecture du choix du client sortent octet pour
 * octet de ce que le vrai serveur a envoye.
 *
 * Autorite : la capture d'une vraie liaison `ldapsearch -Y GSSAPI` face a un
 * vrai slapd (OpenLDAP 2.5, Cyrus SASL 2.1.28, MIT Kerberos 1.20.1), avec la
 * cle du service que `kadmin.local ktadd -norandkey` a ecrite
 * (`mit-gssapi-ldap-capture.json`). Les entiers aleatoires du serveur (sous-cle
 * d'acceptation, numero de sequence, confondeur) sont relus en ouvrant la
 * reponse enregistree avec la cle de session du billet. L'offre est celle de
 * slapd (couches 7, tampon de 65536 octets) ; le DC du simulateur annonce la
 * valeur par defaut de la politique LDAP d'Active Directory.
 *
 * Mesure avant la creation de l'echange serveur : les 7 cas tombent, le fichier
 * ne se charge pas (le module n'existe pas) ; le temoin « the real capture is a
 * complete exchange » ne depend pourtant d'aucun module du simulateur et le
 * resterait seul.
 */
import { describe, it, expect } from 'vitest';
import { parseAll, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import { ApReplayCache } from '@/network/kerberos/ApReqVerifier';
import { decodeApRep, decodeApReq, decodeAuthenticator, decodeEncApRepPart, decodeEncTicketPart } from '@/network/kerberos/codec';
import { AES256_PROFILE, decrypt, decryptWithConfounder } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { parseInitialContextToken } from '@/network/kerberos/gssapi/GssToken';
import { GssapiServerExchange } from '@/network/ldap/gssapi/GssapiServerExchange';
import { LAYER_CONFIDENTIALITY, LAYER_INTEGRITY, LAYER_NONE } from '@/network/ldap/gssapi/Rfc4752';
import { loadJson } from './openldap-replay-support';

interface GssCapture {
  readonly serviceKey: string;
  readonly messages: readonly { dir: string; hex: string }[];
}

const capture = loadJson<GssCapture>('mit-gssapi-ldap-capture.json');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const serviceKey = bytes(capture.serviceKey);
const messages = capture.messages.map((message) => bytes(message.hex));

const KU_TICKET = 2;
const KU_AP_REQ_AUTHENTICATOR = 11;
const KU_AP_REP_ENC_PART = 12;
const REAL_OFFER = { layers: LAYER_NONE | LAYER_INTEGRITY | LAYER_CONFIDENTIALITY, maxBuffer: 65536 };

function bindCredentials(message: Uint8Array): Uint8Array | null {
  const bindRequest = parseAll(parseTLV(message, 0).content)[1];
  const fields = parseAll(parseAll(bindRequest.content)[2].content);
  return fields.length > 1 ? fields[1].content : null;
}

function serverCredentials(message: Uint8Array): Uint8Array {
  const bindResponse = parseAll(parseTLV(message, 0).content)[1];
  return parseAll(bindResponse.content).find((field) => field.tagClass === 'context' && field.tagNumber === 7)!.content;
}

function sequenceBytes(sequence: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, sequence, false);
  return out;
}

function recordedFacts() {
  const apReq = decodeApReq(parseInitialContextToken(bindCredentials(messages[0])!)!.body);
  const sessionKey = decodeEncTicketPart(decrypt(AES256_PROFILE, serviceKey, KU_TICKET, apReq.ticket.encPart.cipher)).key.keyValue;
  const authenticator = decodeAuthenticator(decrypt(AES256_PROFILE, sessionKey, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
  const apRep = decodeApRep(parseInitialContextToken(serverCredentials(messages[1]))!.body);
  const sealed = decryptWithConfounder(AES256_PROFILE, sessionKey, KU_AP_REP_ENC_PART, apRep.encPart.cipher);
  const part = decodeEncApRepPart(sealed.plaintext);
  return { authenticator, subkey: part.subkey!.keyValue, sequence: part.seqNumber!, confounder: sealed.confounder };
}

function exchange(replayCache = new ApReplayCache(), key = serviceKey): GssapiServerExchange {
  const facts = recordedFacts();
  const queues: Record<number, Uint8Array[]> = { 32: [facts.subkey], 4: [sequenceBytes(facts.sequence)], 16: [facts.confounder] };
  return new GssapiServerExchange({
    serviceKey: key, replayCache, offer: REAL_OFFER,
    clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
    random: (length) => queues[length].shift() ?? new Uint8Array(length),
  });
}

describe('the server side of the RFC 4752 exchange against a real slapd transcript', () => {
  it('the real capture is a complete exchange', () => {
    expect(capture.messages.map((message) => message.dir)).toEqual(['c', 's', 'c', 's', 'c', 's', 'c', 's', 'c']);
  });

  it('the first bind carrying the real AP-REQ answers with the very AP-REP token of the real server', () => {
    const step = exchange().step(bindCredentials(messages[0]));
    expect(step.kind).toBe('continue');
    if (step.kind === 'continue') expect(hex(step.credentials)).toBe(hex(serverCredentials(messages[1])));
  });

  it('the empty second bind draws the very wrapped offer of the real server', () => {
    const server = exchange();
    server.step(bindCredentials(messages[0]));
    const step = server.step(bindCredentials(messages[2]));
    expect(step.kind).toBe('continue');
    if (step.kind === 'continue') expect(hex(step.credentials)).toBe(hex(serverCredentials(messages[3])));
  });

  it('the wrapped choice of the real client ends the exchange with the confidentiality layer and the real peer', () => {
    const server = exchange();
    server.step(bindCredentials(messages[0]));
    server.step(bindCredentials(messages[2]));
    const step = server.step(bindCredentials(messages[4]));
    expect(step.kind).toBe('established');
    if (step.kind !== 'established') return;
    expect(step.peer).toEqual({ name: ['alice'], realm: 'CORP.LOCAL' });
    expect(step.authzid).toBe('');
    expect(step.layer!.privacy).toBe(true);
    expect(step.layer!.peerMaxBuffer).toBe(0xffffff);
  });

  it('the established context reads the sealed search of the real client', () => {
    const server = exchange();
    server.step(bindCredentials(messages[0]));
    server.step(bindCredentials(messages[2]));
    const step = server.step(bindCredentials(messages[4]));
    if (step.kind !== 'established') throw new Error('not established');
    const frame = messages[6].subarray(4);
    const search = step.layer!.context.unwrap(frame);
    expect(search.sealed).toBe(true);
    expect(search.data[0]).toBe(0x30);
  });

  it('a replayed AP-REQ is refused by the replay cache the two exchanges share', () => {
    const cache = new ApReplayCache();
    expect(exchange(cache).step(bindCredentials(messages[0])).kind).toBe('continue');
    expect(exchange(cache).step(bindCredentials(messages[0])).kind).toBe('failed');
  });

  it('a service key that did not issue the ticket refuses the first bind', () => {
    const step = exchange(new ApReplayCache(), new Uint8Array(32).fill(9)).step(bindCredentials(messages[0]));
    expect(step.kind).toBe('failed');
  });
});
