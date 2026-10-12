/**
 * Sonde : `ldapsearch -Y GS2-KRB5` du simulateur emet, octet pour octet, ce
 * qu'emet le vrai client, et lit ce que lit le vrai client. 17 scenarios ont
 * ete enregistres avec ldapsearch 2.6.10, Cyrus SASL 2.1.28+dfsg1-5ubuntu3.1
 * (greffon libgs2) et MIT Kerberos 1.20.1, face a un vrai slapd et a un vrai
 * KDC, par les memes relais enregistreurs que le corpus GSS-SPNEGO.
 *
 * Autorite : cyrus-sasl plugins/gs2.c (`gs2_client_mech_step`,
 * `gs2_get_init_creds`, `gs2_make_header`, `gs2_make_message`,
 * `gs2_save_cbindings`) et lib/client.c (`_sasl_client_order_mechs`,
 * `_sasl_cbinding_disp`), lus dans les sources du depot Ubuntu ; les octets
 * du vrai client font foi quand ils divergent.
 *
 * Constats : le premier message est l'en-tete GS2 (`n,,`) suivi du jeton Kerberos
 * dont le cadrage RFC 2743 est retire (le serveur, lui, repond avec un jeton
 * cadre) ; le greffon n'a aucune couche de securite (SSF 0, tampon 0xFFFFFF) ;
 * la premiere passe demande toujours l'identite a l'application (le
 * rappel libldap n'a pas de procedure), de sorte que `-U` ne sert qu'a ne pas
 * echouer sur la lecture de l'entree standard et que l'identite retenue est
 * celle du cache : sans `-U`, la fin de fichier sur l'invite fait echouer
 * l'echange avec le texte obsolete « Unable to find a callback: 32775 » que
 * canon_user laisse dans le tampon d'erreur de la connexion, code -1 compris ;
 * un TGT expire est refuse a l'acquisition (`The referenced credential has
 * expired (Success)`), alors que GSSAPI ne le dit qu'en demandant le billet ;
 * les noms en -PLUS sont ecartes sans canal lie, et le texte du refus est
 * vide.
 *
 * Mesure avant la correction (greffon libgs2 absent du simulateur) : 16 des
 * 18 cas tombent. Passent avant comme apres : le decompte du corpus et le
 * scenario minssf1 (libsasl2 filtre sur le SSF maximal avant d'appeler un
 * mecanisme).
 *
 * Non attestable ici : GS2-IAKERB, que le vrai greffon annonce aussi, n'est pas
 * porte (il relaie les echanges du KDC par le serveur) ; l'acquisition d'un
 * identifiant par mot de passe (`gss_acquire_cred_with_password`), jamais
 * atteinte avec un cache chaud, est refusee en le disant ; l'en-tete `p=` et
 * le `y` de GS2 ne sont pas mesures avec TLS (libldap marque la liaison de
 * canal non critique et ldapsearch impose le mecanisme, donc `n`).
 */
import { describe, it, expect } from 'vitest';
import { loadJson } from './openldap-replay-support';
import { replayGssapiScenario, type GssapiCorpus } from './openldap-gssapi-replay-support';

const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-gs2-krb5-corpus.json');

describe('ldapsearch -Y GS2-KRB5 replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(17);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await replayGssapiScenario(corpus, scenario, scenario.args)).toEqual([]);
    });
  }
});
