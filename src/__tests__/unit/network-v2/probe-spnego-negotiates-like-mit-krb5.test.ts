/**
 * Sonde : l'initiateur et l'accepteur SPNEGO (RFC 4178) du simulateur suivent
 * la machine a etats de MIT krb5 1.20.1 (`spnego_gss_init_sec_context`,
 * `init_ctx_cont`, `init_ctx_nego`, `handle_mic`) : Kerberos seul est offert,
 * le jeton optimiste part avec le NegTokenInit, aucun mechListMIC n'est
 * echange tant que l'accepteur n'en envoie pas, un MIC recu est verifie puis
 * repondu, un rejet avant tout choix est un echec de negociation.
 *
 * Autorite : spnego_mech.c de MIT krb5 1.20.1 (sources du depot Ubuntu) et le
 * jeton du vrai client enregistre dans le corpus de rejeu. Le contexte
 * Kerberos est remplace par un double a cle fixe pour que les cas MIC soient
 * deterministes ; l'echange complet avec un vrai KDC est dans les sondes de
 * rejeu et du controleur de domaine.
 *
 * Mesure avant la creation du module : `gssapi/spnego/` n'existait pas, les
 * 10 cas tombent ; aucun ne passe avant, faute de temoin hors module.
 */
import { describe, expect, it } from 'vitest';
import { parseAll, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import type { GssContextInitiator } from '@/network/kerberos/gssapi/GssInitiator';
import { GssSecurityContext } from '@/network/kerberos/gssapi/GssSecurityContext';
import { GSS_S_BAD_MECH, GSS_S_DEFECTIVE_TOKEN, GSS_S_FAILURE } from '@/network/kerberos/gssapi/GssStatus';
import {
  GSS_C_CONF_FLAG, GSS_C_INTEG_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG, KRB5_MECHANISM_OID,
} from '@/network/kerberos/gssapi/GssToken';
import { SpnegoAcceptor } from '@/network/kerberos/gssapi/spnego/SpnegoAcceptor';
import { SpnegoInitiator } from '@/network/kerberos/gssapi/spnego/SpnegoInitiator';
import {
  NegState, SPNEGO_MECHANISM_OID, decodeSpnegoToken, encodeMechTypes, encodeNegTokenInit, encodeNegTokenResp,
} from '@/network/kerberos/gssapi/spnego/SpnegoToken';
import { loadJson } from './openldap-replay-support';
import type { GssapiCorpus } from './openldap-gssapi-replay-support';

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const MECH_TOKEN = Uint8Array.of(0x60, 0x03, 0x01, 0x02, 0x03);
const REPLY_TOKEN = Uint8Array.of(0x60, 0x02, 0x09, 0x08);
const FLAGS = GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG | GSS_C_INTEG_FLAG | GSS_C_CONF_FLAG;
const NTLM_MECHANISM_OID = '1.3.6.1.4.1.311.2.2.10';

function contexts(): { initiator: GssSecurityContext; acceptor: GssSecurityContext } {
  return {
    initiator: new GssSecurityContext({ role: 'initiator', key: KEY, usesAcceptorSubkey: false, sendSequence: 7, receiveSequence: 9, sequenceChecking: true }),
    acceptor: new GssSecurityContext({ role: 'acceptor', key: KEY, usesAcceptorSubkey: false, sendSequence: 9, receiveSequence: 7, sequenceChecking: true }),
  };
}

function kerberosStub(context: GssSecurityContext, flags = FLAGS): GssContextInitiator {
  let calls = 0;
  return {
    flags,
    clientDisplayName: 'alice@CORP.LOCAL',
    securityContext: context,
    step: () => (++calls === 1 ? { kind: 'continue', output: MECH_TOKEN } : { kind: 'complete', output: null }),
  };
}

function accepted(extra: { micFrom?: GssSecurityContext } = {}): Uint8Array {
  return encodeNegTokenResp({
    negState: NegState.ACCEPT_COMPLETE, supportedMech: KRB5_MECHANISM_OID, responseToken: REPLY_TOKEN,
    mechListMic: extra.micFrom === undefined ? null : extra.micFrom.getMic(encodeMechTypes([KRB5_MECHANISM_OID])),
  });
}

describe('SPNEGO initiator and acceptor negotiate like MIT Kerberos', () => {
  it('the first token is a NegTokenInit offering Kerberos alone with the optimistic token and no MIC', () => {
    const { initiator } = contexts();
    const first = new SpnegoInitiator(kerberosStub(initiator)).step(null);
    expect(first.kind).toBe('continue');
    const token = decodeSpnegoToken((first as { output: Uint8Array }).output)!;
    expect(token.kind === 'init' && token.mechTypes).toEqual([KRB5_MECHANISM_OID]);
    expect(token.kind === 'init' && Buffer.from(token.mechToken!).toString('hex')).toBe(Buffer.from(MECH_TOKEN).toString('hex'));
    expect(token.kind === 'init' && token.mechListMic).toBeNull();
  });

  it('is framed as the real client frames it', () => {
    const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-gss-spnego-corpus.json');
    const bind = Uint8Array.from(Buffer.from(corpus.scenarios.find((scenario) => scenario.name === 'default')!.connections[0].transcript[0][1], 'hex'));
    const sasl = parseAll(parseAll(parseTLV(bind, 0).content)[1].content)[2];
    const real = decodeSpnegoToken(parseAll(sasl.content)[1].content)!;
    expect(real.kind === 'init' && real.mechTypes).toEqual([KRB5_MECHANISM_OID]);
    expect(SPNEGO_MECHANISM_OID).toBe('1.3.6.1.5.5.2');
  });

  it('completes without another token when the acceptor sends none and no MIC', () => {
    const { initiator } = contexts();
    const spnego = new SpnegoInitiator(kerberosStub(initiator));
    spnego.step(null);
    expect(spnego.step(accepted())).toEqual({ kind: 'complete', output: null });
  });

  it('answers a MIC with its own and finishes in the accept-complete state', () => {
    const { initiator, acceptor } = contexts();
    const spnego = new SpnegoInitiator(kerberosStub(initiator));
    spnego.step(null);
    const last = spnego.step(accepted({ micFrom: acceptor }));
    expect(last.kind).toBe('complete');
    const reply = decodeSpnegoToken((last as { output: Uint8Array }).output)!;
    expect(reply.kind === 'resp' && reply.negState).toBe(NegState.ACCEPT_COMPLETE);
    expect(() => acceptor.verifyMic(encodeMechTypes([KRB5_MECHANISM_OID]), (reply as { mechListMic: Uint8Array }).mechListMic)).not.toThrow();
  });

  it('refuses a MIC that does not verify', () => {
    const { initiator } = contexts();
    const stranger = new GssSecurityContext({
      role: 'acceptor', key: new Uint8Array(32).fill(5), usesAcceptorSubkey: false, sendSequence: 9, receiveSequence: 7, sequenceChecking: true,
    });
    const spnego = new SpnegoInitiator(kerberosStub(initiator));
    spnego.step(null);
    const failed = spnego.step(accepted({ micFrom: stranger }));
    expect(failed.kind === 'error' && failed.failure.major).toBe(GSS_S_FAILURE);
  });

  it('reports a rejection before any mechanism was selected as a failure to negotiate', () => {
    const { initiator } = contexts();
    const spnego = new SpnegoInitiator(kerberosStub(initiator));
    spnego.step(null);
    const failed = spnego.step(encodeNegTokenResp({ negState: NegState.REJECT, supportedMech: null, responseToken: null, mechListMic: null }));
    expect(failed.kind === 'error' && failed.failure.major).toBe(GSS_S_BAD_MECH);
    expect(failed.kind === 'error' && failed.failure.minor).toBe('SPNEGO failed to negotiate a mechanism');
  });

  it('refuses a token that is not a NegTokenResp', () => {
    const { initiator } = contexts();
    const spnego = new SpnegoInitiator(kerberosStub(initiator));
    const first = spnego.step(null);
    const failed = spnego.step((first as { output: Uint8Array }).output);
    expect(failed.kind === 'error' && failed.failure.major).toBe(GSS_S_DEFECTIVE_TOKEN);
  });

  it('the acceptor refuses an initiator whose preferred mechanism is not Kerberos', () => {
    const acceptor = new SpnegoAcceptor({ serviceKey: KEY, clock: { nowMicroseconds: () => 0 } });
    const outcome = acceptor.step(encodeNegTokenInit({ mechTypes: [NTLM_MECHANISM_OID, KRB5_MECHANISM_OID], mechToken: MECH_TOKEN, mechListMic: null }));
    expect(outcome.kind).toBe('error');
  });

  it('the acceptor refuses an initiator that sends no optimistic token', () => {
    const acceptor = new SpnegoAcceptor({ serviceKey: KEY, clock: { nowMicroseconds: () => 0 } });
    expect(acceptor.step(encodeNegTokenInit({ mechTypes: [KRB5_MECHANISM_OID], mechToken: null, mechListMic: null })).kind).toBe('error');
  });

  it('the acceptor refuses bytes that are not a SPNEGO token', () => {
    const acceptor = new SpnegoAcceptor({ serviceKey: KEY, clock: { nowMicroseconds: () => 0 } });
    expect(acceptor.step(Uint8Array.of(1, 2, 3)).kind).toBe('error');
  });
});
