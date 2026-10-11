/**
 * Sonde : la delegation d'identifiants de GSS-API (RFC 4121 §4.1.1) : le
 * simulateur produit et lit les memes octets que MIT Kerberos quand
 * `ldapsearch -O passcred` transmet un TGT transmissible. Le jeton initial
 * porte, derriere les indicateurs du total de controle 0x8003, l'option de
 * delegation 1, la longueur et un KRB-CRED (RFC 4120 §5.8) chiffre avec la cle
 * de session du ticket de service (usage 14).
 *
 * Autorite : 2 enregistrements (GSSAPI et GSS-SPNEGO) de vrais clients face a
 * un vrai slapd et un vrai KDC avec un TGT obtenu par `kinit -f`
 * (`openldap-ldapsearch-passcred-forwardable-capture.json`, cle du service
 * relevee dans le keytab). Les parties chiffrees sont ouvertes avec la cle de
 * session du cache ; le simulateur refait le jeton avec l'aleatoire et les
 * deux lectures d'horloge de la capture (celle du KRB-CRED, un microseconde
 * avant celle de l'authenticator).
 *
 * Constats qui ont corrige le code : le nonce du KRB-CRED est le numero de
 * sequence tire, et l'authenticator porte ce numero plus un (MIT incremente
 * apres avoir fabrique le KRB-CRED) ; les drapeaux du billet transmis doivent
 * rester des bits bruts, `enc-pa-rep` (bit 15) etant absent du modele des
 * drapeaux ; le chiffrement du KRB-CRED precede celui de l'authenticator.
 *
 * Mesure avant la correction (pas de KRB-CRED dans le module) : les 8 cas
 * tombent ; aucun temoin hors module n'existe.
 */
import { describe, expect, it } from 'vitest';
import { parseAll, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import {
  decodeApReq, decodeAuthenticator, decodeEncKrbCredPart, decodeKrbCred, encodeKrbCred,
} from '@/network/kerberos/codec';
import { AES256_PROFILE, decryptWithConfounder } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { GssAcceptor } from '@/network/kerberos/gssapi/GssAcceptor';
import { GssInitiator, type GssCredential } from '@/network/kerberos/gssapi/GssInitiator';
import { GSS_C_CONF_FLAG, GSS_C_DELEG_FLAG, GSS_C_INTEG_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG } from '@/network/kerberos/gssapi/GssToken';
import { decodeSpnegoToken } from '@/network/kerberos/gssapi/spnego/SpnegoToken';
import { loadJson } from './openldap-replay-support';
import { serviceSessionKey, type GssapiCorpus, type GssapiScenario } from './openldap-gssapi-replay-support';

interface Capture extends GssapiCorpus {
  readonly serviceKeys: Readonly<Record<string, string>>;
}

const capture = loadJson<Capture>('openldap-ldapsearch-passcred-forwardable-capture.json');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const KU_AP_REQ_AUTHENTICATOR = 11;
const KU_KRB_CRED_ENC_PART = 14;
const LAYERS = GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG | GSS_C_INTEG_FLAG | GSS_C_CONF_FLAG;
const SERVICE_KEY = bytes(capture.serviceKeys['ldap/vm@CORP.LOCAL']);

function firstBindToken(scenario: GssapiScenario): Uint8Array {
  const entry = scenario.connections[0].transcript.find(([direction, chunk]) => direction === 'c' && chunk.length > 2000)!;
  const bind = parseAll(parseTLV(bytes(entry[1]), 0).content)[1];
  const credentials = parseAll(parseAll(bind.content)[2].content)[1].content;
  const spnego = decodeSpnegoToken(credentials);
  return spnego === null ? credentials : spnego.kind === 'init' ? spnego.mechToken! : credentials;
}

function realFacts(scenario: GssapiScenario) {
  const token = firstBindToken(scenario);
  const framed = parseTLV(token, 0);
  const afterOid = parseTLV(framed.content, 0).nextOffset;
  const apReq = decodeApReq(framed.content.subarray(afterOid + 2));
  const key = serviceSessionKey(bytes(capture.caches[scenario.cache!]), ['ldap', 'vm'])!;
  const sealed = decryptWithConfounder(AES256_PROFILE, key, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher);
  const authenticator = decodeAuthenticator(sealed.plaintext);
  const checksum = authenticator.cksum!.checksum;
  const message = decodeKrbCred(checksum.subarray(28));
  const opened = decryptWithConfounder(AES256_PROFILE, key, KU_KRB_CRED_ENC_PART, message.encPart.cipher);
  const part = decodeEncKrbCredPart(opened.plaintext);
  return { token, apReq, key, authenticator, sealed, checksum, message, opened, part };
}

function sequenceBytes(sequence: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, sequence, false);
  return out;
}

describe('GSS-API credential delegation matches MIT Kerberos', () => {
  for (const scenario of capture.scenarios) {
    describe(scenario.name, () => {
      it('the capture carries a KRB-CRED in the authenticator checksum and says so in the flags', () => {
        const facts = realFacts(scenario);
        const view = new DataView(facts.checksum.buffer, facts.checksum.byteOffset, facts.checksum.length);
        expect(view.getUint32(20, true) & GSS_C_DELEG_FLAG).toBe(GSS_C_DELEG_FLAG);
        expect(view.getUint16(24, true)).toBe(1);
        expect(view.getUint16(26, true)).toBe(facts.checksum.length - 28);
      });

      it('re-encoding the decoded KRB-CRED gives the bytes MIT sent, so the codec has MIT\'s layout', () => {
        const facts = realFacts(scenario);
        expect(hex(encodeKrbCred(facts.message))).toBe(hex(facts.checksum.subarray(28)));
      });

      it('the initiator reproduces the real client\'s first token byte for byte', () => {
        const facts = realFacts(scenario);
        const credential: GssCredential = {
          ticket: facts.apReq.ticket, sessionKey: facts.key, clientName: facts.authenticator.cname, clientRealm: facts.authenticator.crealm,
          forwarded: { ticket: facts.message.tickets[0], info: facts.part.ticketInfo[0] },
        };
        const draws = [facts.authenticator.subkey!.keyValue, sequenceBytes(facts.authenticator.seqNumber! - 1), facts.opened.confounder, facts.sealed.confounder];
        const readings = [facts.part.timestamp! * 1_000_000 + facts.part.usec!, facts.authenticator.ctime * 1_000_000 + facts.authenticator.cusec];
        const stepped = new GssInitiator({
          credential, requestedFlags: LAYERS, clock: { nowMicroseconds: () => readings.shift()! }, random: () => draws.shift()!,
        }).step(null);
        expect(stepped.kind).toBe('continue');
        expect(hex((stepped as { output: Uint8Array }).output)).toBe(hex(facts.token));
        expect(draws).toEqual([]);
      });

      it('the acceptor decrypts the forwarded ticket granting ticket the real client sent', () => {
        const facts = realFacts(scenario);
        const acceptor = new GssAcceptor({ serviceKey: SERVICE_KEY, clock: { nowMicroseconds: () => scenario.clockMicroseconds } });
        const outcome = acceptor.step(facts.token);
        expect(outcome.kind).toBe('complete');
        expect(acceptor.delegatedCredential?.info.sname.nameString).toEqual(['krbtgt', 'CORP.LOCAL']);
        expect(hex(acceptor.delegatedCredential!.info.key.keyValue)).toBe(hex(facts.part.ticketInfo[0].key.keyValue));
      });
    });
  }
});
