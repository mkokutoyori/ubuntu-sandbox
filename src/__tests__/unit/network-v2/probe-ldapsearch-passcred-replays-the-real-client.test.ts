/**
 * Sonde : `ldapsearch -O passcred` (SASL_SEC_PASS_CREDENTIALS) avec un TGT que
 * le KDC refuse de transmettre. Le vrai client demande un TGT transmis (TGS-REQ
 * FORWARDED, krbtgt/REALM, options copiees du TGT), essaie deux fois, recoit
 * KDC_ERR_BADOPTION, abandonne la delegation sans le dire et conduit le bind
 * normalement : l'echange LDAP est celui de la sonde GSSAPI / GSS-SPNEGO, seul
 * le trafic KDC change. 2 scenarios enregistres (GSSAPI et GSS-SPNEGO) avec
 * ldapsearch 2.6.10, Cyrus SASL 2.1.28 et MIT Kerberos 1.20.1 face a un vrai
 * slapd et un vrai KDC, par les relais enregistreurs des autres corpus.
 *
 * Autorite : MIT krb5 1.20.1, `krb5_fwd_tgt_creds` (fwd_tgt.c) et
 * `make_gss_checksum` (init_sec_context.c), qui ne fait pas echouer le bind
 * quand le transfert echoue. Le cas qui reussit est dans
 * `probe-gssapi-delegation-matches-mit`.
 *
 * Mesure avant la correction (le simulateur refusait `-O passcred`) : 2 des 3
 * cas tombent ; passe avant comme apres le decompte du corpus.
 *
 * Non attestable ici : le vrai client enveloppe ses TGS-REQ dans un PA-FX-FAST
 * (RFC 6113) et le vrai KDC repond de meme ; le simulateur n'implemente pas
 * FAST, donc aucune reponse TGS reussie du vrai KDC ne peut etre rejouee, et
 * les enregistrements de transfert reussi servent a une autre sonde.
 */
import { describe, it, expect } from 'vitest';
import { loadJson } from './openldap-replay-support';
import { replayGssapiScenario, type GssapiCorpus } from './openldap-gssapi-replay-support';

const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-passcred-corpus.json');

describe('ldapsearch -O passcred replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(2);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await replayGssapiScenario(corpus, scenario, scenario.args)).toEqual([]);
    });
  }
});
