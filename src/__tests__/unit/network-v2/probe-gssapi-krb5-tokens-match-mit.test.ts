/**
 * Sonde : le mecanisme Kerberos de GSS-API (RFC 4121) du simulateur produit et
 * lit les memes octets que MIT Kerberos : le jeton initial (cadrage RFC 2743
 * §3.1, AP-REQ avec le total de controle 0x8003 et ses drapeaux), la reponse
 * AP-REP de l'accepteur et les jetons de protection de messages (Wrap avec et sans
 * confidentialite) que le client et le serveur LDAP s'echangent ensuite.
 *
 * Autorite : un vrai `ldapsearch -Y GSSAPI` (OpenLDAP 2.5, Cyrus SASL, MIT Kerberos
 * 1.20.1) face a un vrai slapd, a travers un relais qui enregistre chaque PDU
 * (`mit-gssapi-ldap-capture.json`). Les parties chiffrees sont ouvertes avec les
 * cles du vrai KDC (cle de ldap/vm ecrite par `ktadd -norandkey`). Le simulateur
 * rejoue la capture avec l'aleatoire de la capture (sous-cle, numero de sequence,
 * confounders, relus en dechiffrant) et l'horloge de l'authenticator : ses octets
 * doivent etre ceux du vrai client, et sa lecture ceux du vrai serveur.
 *
 * Constat qui a corrige le code : le total de controle d'un jeton Wrap sans
 * confidentialite se calcule avec l'usage de CHIFFREMENT (22 accepteur, 24
 * initiateur), pas avec l'usage de signature (23, 25) qui sert aux jetons MIC ;
 * le premier essai, ecrit d'apres le texte du RFC, echouait sur les trois jetons.
 *
 * Mesure avant la creation du module : `gssapi/` n'existait pas, les 12 cas
 * tombent. Passe avant comme apres : le temoin « la capture contient le jeton
 * initial, la reponse, trois jetons clients et deux trames serveur », qui ne
 * touche aucun module du simulateur.
 */
import { describe, expect, it } from 'vitest';
import { parseAll, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import { decodeApReq, decodeApRep, decodeAuthenticator, decodeEncApRepPart, decodeEncTicketPart } from '@/network/kerberos/codec';
import { AES256_PROFILE, decrypt, decryptWithConfounder } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { GssAcceptor } from '@/network/kerberos/gssapi/GssAcceptor';
import { GssInitiator, type GssCredential } from '@/network/kerberos/gssapi/GssInitiator';
import { GssTokenError } from '@/network/kerberos/gssapi/GssSecurityContext';
import {
  GSS_C_CONF_FLAG, GSS_C_INTEG_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG, KRB5_MECHANISM_OID, TOKEN_ID_AP_REP, TOKEN_ID_AP_REQ,
  frameInitialContextToken, parseInitialContextToken,
} from '@/network/kerberos/gssapi/GssToken';
import { loadJson } from './openldap-replay-support';

interface GssCapture {
  readonly serviceKey: string;
  readonly messages: readonly { dir: string; hex: string }[];
}

const capture = loadJson<GssCapture>('mit-gssapi-ldap-capture.json');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const serviceKey = bytes(capture.serviceKey);

const KU_TICKET = 2;
const KU_AP_REQ_AUTHENTICATOR = 11;
const KU_AP_REP_ENC_PART = 12;
const REQUESTED_FLAGS = GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG | GSS_C_CONF_FLAG | GSS_C_INTEG_FLAG;

function bindCredentials(message: Uint8Array): Uint8Array {
  const bindRequest = parseAll(parseTLV(message, 0).content)[1];
  const sasl = parseAll(bindRequest.content)[2];
  const fields = parseAll(sasl.content);
  return fields.length > 1 ? fields[1].content : new Uint8Array(0);
}

function serverCredentials(message: Uint8Array): Uint8Array {
  const bindResponse = parseAll(parseTLV(message, 0).content)[1];
  return parseAll(bindResponse.content).find((field) => field.tagClass === 'context' && field.tagNumber === 7)!.content;
}

function frames(message: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < message.length;) {
    const length = new DataView(message.buffer, message.byteOffset + offset, 4).getUint32(0, false);
    out.push(message.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return out;
}

const messages = capture.messages.map((message) => bytes(message.hex));
const realRequestToken = bindCredentials(messages[0]);
const realReplyToken = serverCredentials(messages[1]);

function realFacts() {
  const apReq = decodeApReq(parseInitialContextToken(realRequestToken)!.body);
  const ticketPart = decodeEncTicketPart(decrypt(AES256_PROFILE, serviceKey, KU_TICKET, apReq.ticket.encPart.cipher));
  const sessionKey = ticketPart.key.keyValue;
  const sealedAuthenticator = decryptWithConfounder(AES256_PROFILE, sessionKey, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher);
  const authenticator = decodeAuthenticator(sealedAuthenticator.plaintext);
  const apRep = decodeApRep(parseInitialContextToken(realReplyToken)!.body);
  const sealedReply = decryptWithConfounder(AES256_PROFILE, sessionKey, KU_AP_REP_ENC_PART, apRep.encPart.cipher);
  const replyPart = decodeEncApRepPart(sealedReply.plaintext);
  return { apReq, ticketPart, sessionKey, authenticator, authenticatorConfounder: sealedAuthenticator.confounder, replyPart, replyConfounder: sealedReply.confounder };
}

function recordedRandom(queues: Readonly<Record<number, Uint8Array[]>>) {
  const remaining = Object.fromEntries(Object.entries(queues).map(([length, values]) => [length, [...values]]));
  return (length: number): Uint8Array => {
    const next = remaining[length]?.shift();
    if (next === undefined) throw new Error(`no recorded random bytes of length ${length}`);
    return next;
  };
}

function sequenceBytes(sequence: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, sequence, false);
  return out;
}

function initiatorWithRecordedRandom(extraConfounders: readonly Uint8Array[] = []): GssInitiator {
  const facts = realFacts();
  const credential: GssCredential = {
    ticket: facts.apReq.ticket, sessionKey: facts.sessionKey, clientName: facts.authenticator.cname, clientRealm: facts.authenticator.crealm,
  };
  return new GssInitiator({
    credential,
    requestedFlags: REQUESTED_FLAGS,
    clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
    random: recordedRandom({
      32: [facts.authenticator.subkey!.keyValue],
      4: [sequenceBytes(facts.authenticator.seqNumber!)],
      16: [facts.authenticatorConfounder, ...extraConfounders],
    }),
  });
}

describe('GSS-API Kerberos tokens against a real MIT exchange', () => {
  it('the capture has the initial token, the reply, three client bind steps and wrapped LDAP traffic', () => {
    expect(messages).toHaveLength(9);
    expect(realRequestToken[0]).toBe(0x60);
    expect(realReplyToken[0]).toBe(0x60);
  });

  it('parses the initial context token of the real client and frames it back byte for byte', () => {
    const parsed = parseInitialContextToken(realRequestToken)!;
    expect(parsed.mechanism).toBe(KRB5_MECHANISM_OID);
    expect(parsed.tokenId).toBe(TOKEN_ID_AP_REQ);
    expect(hex(frameInitialContextToken(parsed.tokenId, parsed.body))).toBe(hex(realRequestToken));
  });

  it('parses the AP-REP token of the real server and frames it back byte for byte', () => {
    const parsed = parseInitialContextToken(realReplyToken)!;
    expect(parsed.tokenId).toBe(TOKEN_ID_AP_REP);
    expect(hex(frameInitialContextToken(parsed.tokenId, parsed.body))).toBe(hex(realReplyToken));
  });

  it('the initiator builds the very AP-REQ token the real client sent', () => {
    const step = initiatorWithRecordedRandom().step(null);
    expect(step.kind).toBe('continue');
    expect(hex((step as { output: Uint8Array }).output)).toBe(hex(realRequestToken));
  });

  it('the initiator completes on the real AP-REP and then reads and writes the tokens the real SASL layer exchanged', () => {
    const facts = realFacts();
    const sealedConfounder = realSealedClientConfounder();
    const initiator = initiatorWithRecordedRandom([sealedConfounder]);
    initiator.step(null);
    expect(initiator.step(realReplyToken).kind).toBe('complete');
    const context = initiator.securityContext!;
    expect(hex(context.unwrap(realServerLayerOffer()).data)).toBe('07010000');
    expect(hex(context.wrap(Uint8Array.from([0x04, 0xff, 0xff, 0xff]), false))).toBe(hex(realClientLayerChoice()));
    const search = realSealedClientPlaintext();
    expect(hex(context.wrap(search, true))).toBe(hex(realSealedClientToken()));
    const [entry, done] = frames(messages[7]);
    expect(context.unwrap(entry).data[0]).toBe(0x30);
    expect(context.unwrap(done).data[0]).toBe(0x30);
    expect(facts.replyPart.subkey!.keyValue).toHaveLength(32);
  });

  it('the acceptor answers the real client with the very AP-REP token the real server sent', () => {
    const facts = realFacts();
    const acceptor = new GssAcceptor({
      serviceKey,
      clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
      random: recordedRandom({
        32: [facts.replyPart.subkey!.keyValue],
        4: [sequenceBytes(facts.replyPart.seqNumber!)],
        16: [facts.replyConfounder],
      }),
    });
    const step = acceptor.step(realRequestToken);
    expect(step.kind).toBe('complete');
    if (step.kind !== 'complete') return;
    expect(step.peer).toEqual({ name: ['alice'], realm: 'CORP.LOCAL' });
    expect(step.flags).toBe(REQUESTED_FLAGS | 0x100);
    expect(hex(step.output!)).toBe(hex(realReplyToken));
  });

  it('the acceptor reads the client tokens and builds the server tokens of the real exchange', () => {
    const facts = realFacts();
    const serverConfounders = realSealedServerConfounders();
    const acceptor = new GssAcceptor({
      serviceKey,
      clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
      random: recordedRandom({
        32: [facts.replyPart.subkey!.keyValue],
        4: [sequenceBytes(facts.replyPart.seqNumber!)],
        16: [facts.replyConfounder, ...serverConfounders],
      }),
    });
    acceptor.step(realRequestToken);
    const context = acceptor.securityContext!;
    expect(hex(context.wrap(Uint8Array.from([0x07, 0x01, 0x00, 0x00]), false))).toBe(hex(realServerLayerOffer()));
    expect(hex(context.unwrap(realClientLayerChoice()).data)).toBe('04ffffff');
    expect(hex(context.unwrap(realSealedClientToken()).data)).toBe(hex(realSealedClientPlaintext()));
    const serverFrames = frames(messages[7]);
    const plains = serverFrames.map((frame) => decryptWithConfounder(AES256_PROFILE, facts.replyPart.subkey!.keyValue, 22, frame.subarray(16)).plaintext);
    serverFrames.forEach((frame, index) => {
      const data = plains[index].slice(0, plains[index].length - 16);
      expect(hex(context.wrap(data, true))).toBe(hex(frame));
    });
  });

  it('refuses a wrap token altered in its data, its header or its checksum', () => {
    const initiator = initiatorWithRecordedRandom();
    initiator.step(null);
    initiator.step(realReplyToken);
    const context = initiator.securityContext!;
    const layerOffer = realServerLayerOffer();
    for (const index of [16, 8, layerOffer.length - 1]) {
      const altered = layerOffer.slice();
      altered[index] ^= 1;
      expect(() => context.unwrap(altered)).toThrow(GssTokenError);
    }
  });

  it('refuses a token read twice (sequence checking)', () => {
    const initiator = initiatorWithRecordedRandom();
    initiator.step(null);
    initiator.step(realReplyToken);
    const context = initiator.securityContext!;
    context.unwrap(realServerLayerOffer());
    expect(() => context.unwrap(realServerLayerOffer())).toThrow(GssTokenError);
  });

  it('refuses an AP-REQ replayed to the same acceptor', async () => {
    const facts = realFacts();
    const { ApReplayCache } = await import('@/network/kerberos/ApReqVerifier');
    const acceptor = new GssAcceptor({
      serviceKey,
      clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
      replayCache: new ApReplayCache(),
    });
    expect(acceptor.step(realRequestToken).kind).toBe('complete');
    const second = acceptor.step(realRequestToken);
    expect(second.kind).toBe('error');
    if (second.kind === 'error') expect(second.errorCode).toBe(34);
  });

  it('refuses an AP-REQ presented long after the authenticator time', () => {
    const facts = realFacts();
    const acceptor = new GssAcceptor({
      serviceKey,
      clock: { nowMicroseconds: () => (facts.authenticator.ctime + 3600) * 1_000_000 },
    });
    const step = acceptor.step(realRequestToken);
    expect(step.kind).toBe('error');
    if (step.kind === 'error') expect(step.errorCode).toBe(37);
  });

  it('refuses a ticket opened with another service key', () => {
    const facts = realFacts();
    const acceptor = new GssAcceptor({
      serviceKey: new Uint8Array(32).fill(1),
      clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 },
    });
    expect(acceptor.step(realRequestToken).kind).toBe('error');
  });
});

function realServerLayerOffer(): Uint8Array {
  return serverCredentials(messages[3]);
}

function realClientLayerChoice(): Uint8Array {
  return bindCredentials(messages[4]);
}

function wrappedClientTokens(): Uint8Array[] {
  return frames(messages[6]);
}

function realSealedClientToken(): Uint8Array {
  return wrappedClientTokens()[0];
}

function realSealedClientPlaintext(): Uint8Array {
  const facts = realFacts();
  const opened = decryptWithConfounder(AES256_PROFILE, facts.replyPart.subkey!.keyValue, 24, realSealedClientToken().subarray(16));
  return opened.plaintext.slice(0, opened.plaintext.length - 16);
}

function realSealedClientConfounder(): Uint8Array {
  const facts = realFacts();
  return decryptWithConfounder(AES256_PROFILE, facts.replyPart.subkey!.keyValue, 24, realSealedClientToken().subarray(16)).confounder;
}

function realSealedServerConfounders(): Uint8Array[] {
  const facts = realFacts();
  return frames(messages[7]).map((frame) => decryptWithConfounder(AES256_PROFILE, facts.replyPart.subkey!.keyValue, 22, frame.subarray(16)).confounder);
}

