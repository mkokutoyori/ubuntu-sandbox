/**
 * Sonde : apres la poignee de main TLS, le client `ldapsearch` decide du sort du
 * pair avec les regles de libldap, pas avec celles du RFC 6125 : la politique
 * `TLS_REQCERT` (never | allow | try | demand | hard) pour la chaine, la
 * verification du nom d'hote de libldap (`tlsg_session_chkhost`) pilotee par
 * `TLS_REQSAN`, l'epinglage de la cle publique `TLS_PEERKEY_HASH`, et le choix
 * de l'indication de nom de serveur (SNI) qui omet une adresse numerique.
 *
 * Autorite : un vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) face a huit slapd en TLS
 * qui presentent des certificats differents (SAN et CN, CN seul, SAN etranger,
 * joker, IP seule, SAN sans CN, expire, pas encore valide). 600 combinaisons
 * certificat x nom x REQCERT x REQSAN ont ete executees et leur issue (donnees
 * rendues ou « Can't contact LDAP server ») consignee dans
 * `openldap-tls-peer-corpus.json`, avec les lignes de trace `TLS:` et `tlsg_`
 * de `-d -1`. Le SNI est mesure avec un serveur Python qui affiche le nom recu.
 * Source lue : libraries/libldap/tls_g.c et tls2.c de OPENLDAP_REL_ENG_2_6_10.
 *
 * Constat qui a corrige le code : `TLS_REQCERT no` etait lu comme `never` alors
 * que libldap ne connait ni `no` ni `0` (la valeur est ignoree et `demand` reste),
 * et `yes` / `on` / `true` valent `hard`, pas `demand` ; la verification de nom
 * etait deleguee au verificateur du RFC 6125, qui ne lit pas `TLS_REQSAN` : ses
 * issues ne sont celles de libldap que pour la valeur par defaut.
 *
 * Mesure avant la modification, les modules `tls/` mis a part (sans eux le fichier
 * ne se charge pas) : les options etaient lues a la facon de l'ancien code, 26 des
 * 62 cas tombent — tout ce qui lit `TLS_REQCERT` ou `TLS_PEERKEY_HASH` par les
 * options. Passent avant comme apres, parce que les modules neufs les portent
 * seuls : le temoin de chaine valide, les 24 matrices de noms, les refus de
 * chaine, la formule de l'empreinte SPKI et les cinq cas de SNI.
 *
 * Non attestable : les etats GnuTLS d'une chaine refusee autres que « signataire
 * inconnu » (0x42), « expire » (0x402) et « pas encore actif » (0x202) — l'etat de
 * « revoque », « signature invalide » et « signataire sans droit de CA » est tire
 * des constantes de gnutls.h, pas d'une capture.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pemToCert } from '@/network/pki/pem';
import { encodeSubjectPublicKeyInfo } from '@/network/pki/der/X509Der';
import { applyConfigOption, defaultLdapOptions, TlsRequireCert } from '@/network/ldap/openldap/ldapOptions';
import { judgeChain, judgePeer } from '@/network/ldap/openldap/tls/tlsPeerPolicy';
import { connectTls, type TlsConnectHost } from '@/network/ldap/openldap/tls/tlsConnect';
import type { TlsUpgradeRequest } from '@/network/ldap/openldap/ldapChannel';
import { LdapRc } from '@/network/ldap/openldap/ldapErrors';
import { loadJson } from './openldap-replay-support';

interface PinRow {
  readonly label: string;
  readonly value: string;
  readonly accepted: boolean;
  readonly startTls: string;
  readonly lines: readonly string[];
}

interface ChainRow {
  readonly pem: string;
  readonly results: Readonly<Record<string, string>>;
  readonly lines: readonly string[];
}

interface PeerCorpus {
  readonly localFqdn: string;
  readonly certificates: Readonly<Record<string, string>>;
  readonly hostMatrix: Readonly<Record<string, string>>;
  readonly chains: Readonly<Record<'expired' | 'future', ChainRow>>;
  readonly untrustedLines: readonly string[];
  readonly pins: readonly PinRow[];
  readonly serverNameIndication: Readonly<Record<string, string | null>>;
}

const corpus = loadJson<PeerCorpus>('openldap-tls-peer-corpus.json');
const MODES = ['never', 'allow', 'try', 'demand', 'hard'] as const;
const MODE_VALUE = {
  never: TlsRequireCert.NEVER, allow: TlsRequireCert.ALLOW, try: TlsRequireCert.TRY,
  demand: TlsRequireCert.DEMAND, hard: TlsRequireCert.HARD,
} as const;

function certificateOf(name: string) {
  return pemToCert(corpus.certificates[name])!;
}

function tlsWith(requireCert: number, requireSan: number, peerKeyHash?: string) {
  const options = defaultLdapOptions();
  options.tls.requireCert = requireCert;
  options.tls.requireSan = requireSan;
  if (peerKeyHash !== undefined) applyConfigOption(options, 'TLS_PEERKEY_HASH', peerKeyHash, 'environment');
  return options.tls;
}

describe('the host name check of libldap, over 600 measured combinations', () => {
  it('every certificate of the corpus is a valid chain, so only the name decides (witness)', () => {
    for (const name of Object.keys(corpus.certificates)) {
      expect(judgeChain(TlsRequireCert.HARD, certificateOf(name), { ok: true }).ok).toBe(true);
    }
    expect(Object.keys(corpus.hostMatrix)).toHaveLength(24);
  });

  for (const [key, outcomes] of Object.entries(corpus.hostMatrix)) {
    const [certificate, host] = key.split('/');
    it(`${certificate} presented to ${host}: the 25 REQCERT x REQSAN answers are those of the real client`, () => {
      const cert = certificateOf(certificate);
      const got = MODES.flatMap((requireCert) => MODES.map((requireSan) => {
        const tls = tlsWith(MODE_VALUE[requireCert], MODE_VALUE[requireSan]);
        return judgePeer(tls, host, cert, corpus.localFqdn).ok ? 'Y' : '.';
      })).join('');
      expect(got).toBe(outcomes);
    });
  }
});

describe('the certificate chain policy of libldap', () => {
  for (const name of ['expired', 'future'] as const) {
    it(`a ${name} certificate is refused unless TLS_REQCERT is never or allow, with the trace line of the real client`, () => {
      const row = corpus.chains[name];
      const cert = pemToCert(row.pem)!;
      const reason = name === 'expired' ? 'expired' : 'not-yet-valid';
      for (const mode of MODES) {
        const verdict = judgeChain(MODE_VALUE[mode], cert, { ok: false, reason });
        expect(verdict.ok ? 'Y' : '.').toBe(row.results[mode]);
      }
      const refused = judgeChain(TlsRequireCert.DEMAND, cert, { ok: false, reason });
      expect(refused.ok).toBe(false);
      if (refused.ok !== false) return;
      expect(refused.lines.map((line) => line.text.trimEnd())).toEqual([row.lines[0]]);
    });
  }

  it('an unknown signer is reported as status 0x42, like the real client', () => {
    const verdict = judgeChain(TlsRequireCert.DEMAND, certificateOf('san_ok'), { ok: false, reason: 'unknown' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok !== false) return;
    expect(verdict.lines.map((line) => line.text.trimEnd())).toEqual([corpus.untrustedLines[0]]);
  });

  it('a missing peer certificate is tolerated only by try', () => {
    expect(judgeChain(TlsRequireCert.TRY, null, { ok: false, reason: 'unknown' }).ok).toBe(true);
    expect(judgeChain(TlsRequireCert.DEMAND, null, { ok: false, reason: 'unknown' }).ok).toBe(false);
  });
});

describe('the public key pin of libldap (TLS_PEERKEY_HASH)', () => {
  for (const row of corpus.pins) {
    it(`${row.label}: ${row.accepted ? 'accepted' : 'refused'} with the real trace lines and errno`, () => {
      const cert = certificateOf('san_ok');
      const tls = tlsWith(TlsRequireCert.DEMAND, TlsRequireCert.ALLOW, row.value);
      const verdict = judgePeer(tls, 'vm', cert, corpus.localFqdn);
      expect(verdict.ok).toBe(row.accepted);
      if (verdict.ok !== false) return;
      expect(verdict.errno).toBe(row.startTls.includes('(-1)') ? LdapRc.SERVER_DOWN : LdapRc.CONNECT_ERROR);
      expect(verdict.lines.map((line) => line.text.trimEnd())).toEqual(row.lines);
    });
  }

  it('the SPKI the pin is computed over is the DER openssl writes for the public key', () => {
    const cert = certificateOf('san_ok');
    const der = Buffer.from(encodeSubjectPublicKeyInfo(cert.publicKey));
    const row = corpus.pins.find((candidate) => candidate.label === 'sha256 of the key')!;
    expect(row.value).toBe(`sha256:${createHash('sha256').update(der).digest('base64')}`);
  });

  it('is evaluated even when TLS_REQCERT is never, as the real client does', () => {
    const cert = certificateOf('san_ok');
    const wrong = corpus.pins.find((candidate) => candidate.label === 'sha256 of another value')!;
    expect(judgePeer(tlsWith(TlsRequireCert.NEVER, TlsRequireCert.ALLOW, wrong.value), 'vm', cert, corpus.localFqdn).ok).toBe(false);
  });
});

describe('the options that drive the peer policy', () => {
  function requireCertAfter(value: string): number {
    const options = defaultLdapOptions();
    applyConfigOption(options, 'TLS_REQCERT', value, 'environment');
    return options.tls.requireCert;
  }

  it('reads the values libldap knows, whatever their case', () => {
    expect(requireCertAfter('never')).toBe(TlsRequireCert.NEVER);
    expect(requireCertAfter('NEVER')).toBe(TlsRequireCert.NEVER);
    expect(requireCertAfter('Allow')).toBe(TlsRequireCert.ALLOW);
    expect(requireCertAfter('try')).toBe(TlsRequireCert.TRY);
    expect(requireCertAfter('demand')).toBe(TlsRequireCert.DEMAND);
  });

  it('reads yes, on, true and hard as hard', () => {
    for (const value of ['yes', 'on', 'true', 'hard', 'Hard']) expect(requireCertAfter(value)).toBe(TlsRequireCert.HARD);
  });

  it('leaves the previous value for what libldap does not know: no, 0, 1, banana and the empty string', () => {
    for (const value of ['no', '0', '1', 'banana', '']) expect(requireCertAfter(value)).toBe(TlsRequireCert.DEMAND);
  });

  it('TLS_PEERKEY_HASH: a bad value keeps the previous pin and an empty value clears it', () => {
    const options = defaultLdapOptions();
    applyConfigOption(options, 'TLS_PEERKEY_HASH', 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'userconf');
    expect(options.tls.peerKeyHash?.algorithm).toBe('sha256');
    applyConfigOption(options, 'TLS_PEERKEY_HASH', 'bogus', 'userconf');
    expect(options.tls.peerKeyHash?.algorithm).toBe('sha256');
    applyConfigOption(options, 'TLS_PEERKEY_HASH', '', 'userconf');
    expect(options.tls.peerKeyHash).toBeNull();
  });

  it('empty file options are unset', () => {
    const options = defaultLdapOptions();
    for (const name of ['TLS_CACERT', 'TLS_CACERTDIR', 'TLS_CERT', 'TLS_KEY', 'TLS_CRLFILE', 'TLS_CIPHER_SUITE']) {
      applyConfigOption(options, name, '/x', 'userconf');
      applyConfigOption(options, name, '', 'userconf');
    }
    expect([options.tls.caCertFile, options.tls.caCertDir, options.tls.certFile, options.tls.keyFile, options.tls.crlFile, options.tls.cipherSuite])
      .toEqual([null, null, null, null, null, null]);
  });
});

describe('the server name indication of libldap', () => {
  const noFiles = { read: () => ({ error: 'No such file or directory' }), regularFiles: () => null } as const;

  function hostSeeing(received: { serverName: string | undefined }): TlsConnectHost {
    return {
      files: noFiles,
      localFqdn: async () => corpus.localFqdn,
      handshake(config) {
        received.serverName = config.serverName;
        return { established: false, alert: false, certificate: null, verification: { ok: true } };
      },
      detach: () => undefined,
    };
  }

  for (const [host, expected] of Object.entries(corpus.serverNameIndication)) {
    it(`${host} is sent as ${expected === null ? 'no indication' : `"${expected}"`}`, async () => {
      const received: { serverName: string | undefined } = { serverName: 'unset' };
      const options = defaultLdapOptions();
      options.tls.caCertFile = null;
      const request: TlsUpgradeRequest = { serverName: host, tls: options.tls, implicit: true, debug: () => undefined };
      await connectTls(request, hostSeeing(received));
      expect(received.serverName).toBe(expected ?? undefined);
    });
  }

  it('the TLS stack is asked to leave the name check to libldap', async () => {
    let seen: boolean | undefined;
    const host: TlsConnectHost = {
      ...hostSeeing({ serverName: undefined }),
      handshake(config) {
        seen = config.verifyHostname;
        return { established: false, alert: false, certificate: null, verification: { ok: true } };
      },
    };
    const options = defaultLdapOptions();
    await connectTls({ serverName: 'vm', tls: options.tls, implicit: true, debug: () => undefined }, host);
    expect(seen).toBe(false);
  });
});
