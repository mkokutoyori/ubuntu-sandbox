/**
 * Sonde : `ldapsearch -Y GSS-SPNEGO` du simulateur emet, octet pour octet, ce
 * qu'emet le vrai client, et lit ce que lit le vrai client. 22 scenarios ont
 * ete enregistres avec ldapsearch 2.6.10, Cyrus SASL 2.1.28+dfsg1-5ubuntu3.1
 * (greffon libgssapiv2 et ses correctifs Ubuntu 0034 channel binding et 0035
 * maxssf 0) et MIT Kerberos 1.20.1, face a un vrai slapd et a un vrai KDC, a
 * travers des relais TCP enregistreurs (LDAP et KDC) ; /etc/hosts est remplace
 * par montage prive pour que `127.0.0.1` se resolve en `vm` comme dans le
 * corpus GSSAPI. L'aleatoire (sous-cle, numero de sequence, confounders, nonce
 * du KDC) est relu dans la capture en dechiffrant avec la cle du service.
 *
 * Autorite : cyrus-sasl plugins/gssapi.c (`gssapi_client_mech_step`,
 * `gssapi_spnego_ssf`) et MIT krb5 src/lib/gssapi/spnego/spnego_mech.c
 * (`init_ctx_*`, `handle_mic`), lus dans les sources du depot Ubuntu ; les
 * octets du vrai client font foi quand ils divergent.
 *
 * Constats : le jeton initial est un NegTokenInit qui n'offre que Kerberos,
 * avec le jeton optimiste et sans mechListMIC ; le serveur termine en un seul
 * tour (resultat success portant le NegTokenResp accept-completed et l'AP-REP) ;
 * il n'y a pas de negociation de couche RFC 4752, la couche decoule des
 * drapeaux du contexte (donc `maxssf=1` laisse le SSF a 256 et `maxssf=0`
 * le met a 0 sans couche) ; un cache absent, vide ou illisible se dit « SPNEGO
 * cannot find mechanisms to negotiate » ; un TGT expire declenche, comme avec
 * GSSAPI, une requete AS sans cle et une entree `refresh_time` dans le cache.
 *
 * Mesure avant la correction (client sans le mecanisme GSS-SPNEGO) : 21 des 24
 * cas tombent. Passent avant comme apres : le decompte du corpus (il ne touche
 * aucun module), le temoin « the replay refuses a request that differs from the
 * recorded one » (il echoue pour toute requete differente) et le scenario
 * minssf300 (libsasl2 filtre sur le SSF maximal du mecanisme avant d'en
 * appeler un).
 *
 * Non attestable ici : la delegation (`-O passcred`) a ses propres sondes ; les
 * requetes TGS ne sont comparees que par options, noms et domaine (voir la
 * sonde GSSAPI).
 */
import { describe, it, expect } from 'vitest';
import { loadJson } from './openldap-replay-support';
import { replayGssapiScenario, type GssapiCorpus } from './openldap-gssapi-replay-support';

const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-gss-spnego-corpus.json');

describe('ldapsearch -Y GSS-SPNEGO replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(22);
  });

  it('the replay refuses a request that differs from the recorded one', async () => {
    const scenario = corpus.scenarios.find((candidate) => candidate.name === 'default')!;
    const altered = scenario.args.flatMap((arg) => (arg === 'GSS-SPNEGO' ? [arg, '-O', 'minssf=300'] : [arg]));
    const problems = await replayGssapiScenario(corpus, scenario, altered);
    expect(problems.length).toBeGreaterThan(0);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await replayGssapiScenario(corpus, scenario, scenario.args)).toEqual([]);
    });
  }
});
