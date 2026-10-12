/**
 * Sonde : la liaison de canal (RFC 5929, RFC 4121 §4.1.1.2) que le client
 * `ldapsearch` place dans l'authenticator Kerberos quand `SASL_CBINDING` vaut
 * `tls-endpoint` et que la connexion est protegee par TLS : le simulateur calcule
 * les memes octets que libldap/GnuTLS, MIT Kerberos les met dans le meme champ
 * et l'accepteur applique la meme regle de comparaison.
 *
 * Autorite : un vrai `ldapsearch -H ldaps://vm:6360 -Y GSSAPI` (OpenLDAP 2.6.10, GnuTLS 3.8.3,
 * Cyrus SASL, MIT Kerberos 1.20.1) face a un vrai slapd en TLS, avec
 * `SASL_CBINDING tls-endpoint` dans ldap.conf ; le jeton initial est relu au
 * moyen de la cle de `ldap/vm` ecrite par `ktadd -norandkey`
 * (`mit-gssapi-channel-binding-capture.json`, avec le certificat DER du serveur).
 * La regle de l'accepteur (refus seulement si les DEUX cotes fournissent une
 * liaison et qu'elles different, `GSS_S_BAD_BINDINGS` « Incorrect channel
 * bindings were supplied ») a ete mesuree avec un vrai `gss_accept_sec_context`
 * de MIT 1.20.1 : liaison identique acceptee, liaison differente refusee,
 * liaison absente d'un cote acceptee. Ce programme de mesure n'est pas livre :
 * il ne peut pas etre rejoue ici, la regle est donc epinglee par ces cas.
 *
 * Constat qui a corrige le code : le champ Bnd de l'authenticator n'est PAS le
 * condense des donnees de liaison, c'est le MD5 de la structure
 * gss_channel_bindings_struct serialisee (quatre entiers 32 bits petit-boutiens
 * nuls pour les adresses, puis la longueur des donnees applicatives et les
 * donnees), soit `tls-server-end-point:` suivi du SHA-256 du certificat.
 *
 * Mesure avant la modification, le module `tls/channelBinding.ts` mis a part
 * (sans lui le fichier ne se charge pas) : le champ Bnd etait toujours nul et
 * l'accepteur ne lisait pas de liaison — 4 des 8 cas tombent : le condense des
 * liaisons, les seize octets nuls, le jeton de l'initiateur et le refus de
 * l'accepteur. Passent avant comme apres, chacun pour sa raison : le temoin « la
 * capture contient un Bnd non nul » (il ne touche aucun module du simulateur) ;
 * la formule `tls-server-end-point:` (portee par le module neuf) ; l'acceptation
 * du vrai jeton avec la meme liaison (l'ancien accepteur acceptait tout) ; et
 * le jeton sans liaison accepte quand l'accepteur en detient une (non-regression).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeApReq, decodeAuthenticator, decodeEncTicketPart } from '@/network/kerberos/codec';
import { AES256_PROFILE, decrypt, decryptWithConfounder } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { GssAcceptor } from '@/network/kerberos/gssapi/GssAcceptor';
import { GssInitiator, type GssCredential } from '@/network/kerberos/gssapi/GssInitiator';
import { GSS_S_BAD_BINDINGS, describeGssFailure } from '@/network/kerberos/gssapi/GssStatus';
import { channelBindingsDigest, parseInitialContextToken } from '@/network/kerberos/gssapi/GssToken';
import { sha256 } from '@/crypto/hash';
import { tlsServerEndPointOfDer } from '@/network/tls/channelBinding';
import { loadJson } from './openldap-replay-support';

interface BindingCapture {
  readonly serviceKey: string;
  readonly apReqToken: string;
  readonly certificateDer: string;
  readonly bindingData: string;
}

const capture = loadJson<BindingCapture>('mit-gssapi-channel-binding-capture.json');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const realToken = bytes(capture.apReqToken);
const serviceKey = bytes(capture.serviceKey);
const certificateDer = bytes(capture.certificateDer);

const BND_OFFSET = 4;
const BND_END = 20;
const FLAGS_OFFSET = 20;

function realFacts() {
  const apReq = decodeApReq(parseInitialContextToken(realToken)!.body);
  const ticketPart = decodeEncTicketPart(decrypt(AES256_PROFILE, serviceKey, 2, apReq.ticket.encPart.cipher));
  const sealed = decryptWithConfounder(AES256_PROFILE, ticketPart.key.keyValue, 11, apReq.authenticator.cipher);
  const authenticator = decodeAuthenticator(sealed.plaintext);
  const checksum = authenticator.cksum!.checksum;
  return {
    apReq, ticketPart, authenticator, confounder: sealed.confounder,
    bnd: checksum.slice(BND_OFFSET, BND_END),
    flags: new DataView(checksum.buffer, checksum.byteOffset, checksum.length).getUint32(FLAGS_OFFSET, true),
  };
}

function recordedRandom(queues: Readonly<Record<number, Uint8Array[]>>) {
  const remaining = Object.fromEntries(Object.entries(queues).map(([length, values]) => [length, [...values]]));
  return (length: number): Uint8Array => {
    const next = remaining[length]?.shift();
    if (next === undefined) throw new Error(`no recorded random bytes of length ${length}`);
    return next;
  };
}

function initiator(channelBindings: Uint8Array | null): GssInitiator {
  const facts = realFacts();
  const credential: GssCredential = {
    ticket: facts.apReq.ticket, sessionKey: facts.ticketPart.key.keyValue,
    clientName: facts.authenticator.cname, clientRealm: facts.authenticator.crealm,
  };
  const sequence = new Uint8Array(4);
  new DataView(sequence.buffer).setUint32(0, facts.authenticator.seqNumber!, false);
  return new GssInitiator({
    credential, requestedFlags: facts.flags, channelBindings,
    clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
    random: recordedRandom({ 32: [facts.authenticator.subkey!.keyValue], 4: [sequence], 16: [facts.confounder] }),
  });
}

function acceptorWith(channelBindings: Uint8Array | null): GssAcceptor {
  const facts = realFacts();
  return new GssAcceptor({
    serviceKey, channelBindings,
    clock: { nowMicroseconds: () => facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec },
  });
}

const bindingData = bytes(capture.bindingData);

describe('GSS-API channel bindings against a real MIT exchange over TLS', () => {
  it('the real authenticator carries a non-zero Bnd, and it is the MD5 of the serialised bindings structure (witness)', () => {
    const facts = realFacts();
    expect(facts.bnd.some((byte) => byte !== 0)).toBe(true);
    const lengthBytes = Buffer.alloc(4);
    lengthBytes.writeUInt32LE(bindingData.length);
    const structure = Buffer.concat([Buffer.alloc(16), lengthBytes, bindingData]);
    expect(hex(facts.bnd)).toBe(createHash('md5').update(structure).digest('hex'));
  });

  it('tls-server-end-point is the prefix followed by the SHA-256 of the certificate DER', () => {
    const data = tlsServerEndPointOfDer(certificateDer, sha256);
    expect(new TextDecoder().decode(data.subarray(0, 21))).toBe('tls-server-end-point:');
    expect(hex(data.subarray(21))).toBe(createHash('sha256').update(certificateDer).digest('hex'));
    expect(hex(data)).toBe(capture.bindingData);
  });

  it('the digest of the bindings is the Bnd of the real authenticator', () => {
    expect(hex(channelBindingsDigest(bindingData))).toBe(hex(realFacts().bnd));
  });

  it('no bindings give sixteen zero bytes', () => {
    expect(hex(channelBindingsDigest(null))).toBe('00'.repeat(16));
  });

  it('the initiator builds the very AP-REQ token the real client sent when it is given the same bindings', () => {
    const step = initiator(bindingData).step(null);
    expect(step.kind).toBe('continue');
    expect(hex((step as { output: Uint8Array }).output)).toBe(hex(realToken));
  });

  it('the acceptor accepts the real token when it holds the same bindings', () => {
    expect(acceptorWith(bindingData).step(realToken).kind).toBe('complete');
  });

  it('the acceptor refuses the real token when it holds other bindings, in MIT words', () => {
    const step = acceptorWith(new TextEncoder().encode('tls-server-end-point:another certificate')).step(realToken);
    expect(step.kind).toBe('error');
    if (step.kind !== 'error') return;
    expect(step.failure?.major).toBe(GSS_S_BAD_BINDINGS);
    expect(describeGssFailure(step.failure!)).toBe('Incorrect channel bindings were supplied (Success)');
  });

  it('the acceptor holding no bindings accepts the real token, and holding some accepts a token that carries none', () => {
    expect(acceptorWith(null).step(realToken).kind).toBe('complete');
    const unbound = initiator(null).step(null) as { output: Uint8Array };
    expect(hex(unbound.output)).not.toBe(hex(realToken));
    expect(acceptorWith(bindingData).step(unbound.output).kind).toBe('complete');
  });
});
