/**
 * Sonde : le classement des mecanismes SASL cote client reprend celui de
 * libsasl2 (`mech_compare`, lib/client.c de cyrus-sasl 2.1.28, sources
 * telechargees du depot Ubuntu). La reference est `saslpluginviewer -c`
 * execute ici avec les modules du paquet libsasl2-modules et
 * libsasl2-modules-gssapi-mit : « GSS-SPNEGO GSSAPI SCRAM-SHA-512
 * SCRAM-SHA-384 SCRAM-SHA-256 SCRAM-SHA-224 SCRAM-SHA-1 GS2-KRB5 GS2-IAKERB
 * DIGEST-MD5 EXTERNAL CRAM-MD5 NTLM PLAIN LOGIN ANONYMOUS ».
 *
 * Les indicateurs de securite, les fonctions annoncees et le meilleur SSF de
 * chaque greffon sont ceux que le meme outil affiche (« security flags »,
 * « features », « best SSF »). Le choix du mecanisme par `sasl_client_start`
 * en depend : premier mecanisme de cette liste que le serveur propose et qui
 * respecte les proprietes de securite demandees.
 *
 * Mesure avant la creation du module : les 6 cas tombent, `saslClient.ts`
 * n'existe pas. Temoin : « the real order is not alphabetical » exige que
 * l'ordre attendu differe du tri alphabetique, sans quoi un classement qui
 * ne ferait rien passerait pour juste.
 */
import { describe, it, expect } from 'vitest';
import { SaslClientConn, orderMechanisms } from '@/network/ldap/openldap/sasl/saslClient';
import {
  SaslFeat, SaslRc, SaslSec, defaultSecurityProperties, hashStrengthBits, type ClientMechanism,
} from '@/network/ldap/openldap/sasl/saslTypes';

const NA = SaslSec.NOANONYMOUS;
const NP = SaslSec.NOPLAINTEXT;
const NACT = SaslSec.NOACTIVE;
const ND = SaslSec.NODICTIONARY;
const PC = SaslSec.PASS_CREDENTIALS;
const MA = SaslSec.MUTUAL_AUTH;
const WCF = SaslFeat.WANT_CLIENT_FIRST;
const PROXY = SaslFeat.ALLOWS_PROXY;
const NSF = SaslFeat.NEEDSERVERFQDN;
const CB = SaslFeat.CHANNEL_BINDING;
const HTTP = SaslFeat.SUPPORTS_HTTP;
const SF = SaslFeat.SERVER_FIRST;

function stub(name: string, maxSsf: number, securityFlags: number, features: number): ClientMechanism {
  const session = { step: () => ({ rc: SaslRc.CONTINUE }) };
  return { name, maxSsf, securityFlags, features, requiredPrompts: null, create: () => session };
}

const HASH = hashStrengthBits;

const PLUGIN_FILES: readonly (readonly ClientMechanism[])[] = [
  [
    stub('GSSAPI', 256, NA | NP | NACT | PC | MA, WCF | PROXY | NSF | CB),
    stub('GSS-SPNEGO', 256, NA | NP | NACT | PC | MA, WCF | PROXY | NSF | CB | HTTP),
  ],
  [
    stub('SCRAM-SHA-512', 0, HASH(512) | NA | NP | NACT | MA, PROXY | CB | HTTP),
    stub('SCRAM-SHA-384', 0, HASH(384) | NA | NP | NACT | MA, PROXY | CB | HTTP),
    stub('SCRAM-SHA-256', 0, HASH(256) | NA | NP | NACT | MA, PROXY | CB | HTTP),
    stub('SCRAM-SHA-224', 0, HASH(224) | NA | NP | NACT | MA, PROXY | CB | HTTP),
    stub('SCRAM-SHA-1', 0, HASH(160) | NA | NP | NACT | MA, PROXY | CB | HTTP),
  ],
  [
    stub('GS2-KRB5', 0, NA | NP | NACT | PC | MA, WCF | NSF | CB | 0x0100),
    stub('GS2-IAKERB', 0, NA | NP | NACT | PC | MA, WCF | NSF | CB | 0x0100),
  ],
  [stub('DIGEST-MD5', 128, NA | NP | MA, PROXY | NSF | HTTP)],
  [stub('EXTERNAL', 0, NA | NP | ND, WCF | PROXY)],
  [stub('CRAM-MD5', 0, NA | NP, SF)],
  [stub('NTLM', 0, NA | NP, WCF | HTTP)],
  [stub('PLAIN', 0, NA | PC, WCF | PROXY)],
  [stub('LOGIN', 0, NA | PC, SF)],
  [stub('ANONYMOUS', 0, NP, WCF)],
];

const LOAD_ORDER: readonly ClientMechanism[] = PLUGIN_FILES.flat();

const REAL_ORDER = [
  'GSS-SPNEGO', 'GSSAPI', 'SCRAM-SHA-512', 'SCRAM-SHA-384', 'SCRAM-SHA-256', 'SCRAM-SHA-224', 'SCRAM-SHA-1',
  'GS2-KRB5', 'GS2-IAKERB', 'DIGEST-MD5', 'EXTERNAL', 'CRAM-MD5', 'NTLM', 'PLAIN', 'LOGIN', 'ANONYMOUS',
];

function environment(plugins: readonly ClientMechanism[]) {
  return { plugins, clientFqdn: 'vm', hostname: 'vm', random: (length: number) => new Uint8Array(length) };
}

function startedWith(server: string, plugins: readonly ClientMechanism[], configure: (conn: SaslClientConn) => void = () => {}) {
  const created = SaslClientConn.create('ldap', 'dc.corp.local', environment(plugins));
  const conn = created.conn!;
  conn.setSecProps(defaultSecurityProperties());
  configure(conn);
  return conn.start(server, null);
}

describe('the client mechanism list is ordered like libsasl2', () => {
  it('the real order is not alphabetical', () => {
    const alphabetical = [...REAL_ORDER].sort();
    expect(alphabetical).not.toEqual(REAL_ORDER);
  });

  it('the plugins in load order come out in the order saslpluginviewer prints', () => {
    expect(orderMechanisms(LOAD_ORDER).map((mech) => mech.name)).toEqual(REAL_ORDER);
  });

  it('with the default security properties the first offered mechanism that passes wins', () => {
    const outcome = startedWith('PLAIN LOGIN CRAM-MD5 DIGEST-MD5', LOAD_ORDER);
    expect(outcome.mech).toBe('DIGEST-MD5');
  });

  it('a server list holding only plaintext mechanisms finds none under the default noplain', () => {
    const outcome = startedWith('PLAIN LOGIN ANONYMOUS', LOAD_ORDER);
    expect(outcome.rc).toBe(SaslRc.NOMECH);
  });

  it('with the security properties set to none the strongest plaintext mechanism is taken', () => {
    const outcome = startedWith('PLAIN LOGIN ANONYMOUS', LOAD_ORDER, (conn) => {
      conn.setSecProps({ ...defaultSecurityProperties(), securityFlags: 0 });
    });
    expect(outcome.mech).toBe('PLAIN');
  });

  it('a mechanism that needs the server name is skipped when none is known', () => {
    const created = SaslClientConn.create('ldap', null, environment(LOAD_ORDER));
    const conn = created.conn!;
    conn.setSecProps({ ...defaultSecurityProperties(), securityFlags: 0 });
    expect(conn.start('GSSAPI DIGEST-MD5 CRAM-MD5', null).mech).toBe('CRAM-MD5');
  });
});
