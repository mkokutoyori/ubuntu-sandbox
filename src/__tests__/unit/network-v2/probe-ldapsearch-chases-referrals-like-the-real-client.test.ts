/**
 * Sonde : `ldapsearch -C` suit les referrals et les references de recherche
 * comme le vrai client OpenLDAP. Le port rejoue 19 executions du vrai client
 * (clone du depot officiel, branche 2.5, compile ici) face a DEUX vrais slapd
 * (suffixe dc=local chacun, relies par des entrees `referral`), a travers un
 * relais qui enregistre chaque connexion separement et l'ordre global des
 * octets. La nouvelle connexion, le rebind anonyme ou authentifie, la
 * requete rechiffree avec le DN et la portee de l'URL, la detection de
 * boucle (CLIENT_LOOP), l'URL a extension critique refusee, la cible qui
 * refuse la connexion (referral non suivi, rendu tel quel dans `text:`), la
 * liste de referrals dont le premier est mort, `-M`, `-P 2`, `-l` et la
 * reference de continuation d'un `-s sub` : les requetes sur le fil, la
 * sortie standard, la sortie d'erreur et le code de sortie sont ceux du vrai
 * client, octet pour octet.
 *
 * Mesure avant la correction (ancien port, `-C` accepte et ignore) : 11 des
 * 19 cas tombent. Les 8 qui passent avant et apres le font pour une raison
 * nommee : chase-no-flag-sub, chase-opt-off, chase-v2, plain-no-chase et
 * chase-manage ne chassent rien (temoins de non-regression : sans `-C`, `-P 2`
 * ou avec `-M`, le client rend le referral), chase-bound-bad echoue au bind
 * avant tout referral, chase-crit est refuse avant toute connexion et
 * chase-ldaprc ne declenche aucun referral.
 *
 * Le rejeu modele l'arrivee des reponses : une reponse n'est visible qu'une
 * fois que tout ce qui est deja arrive a ete lu (le client n'attend que si
 * rien n'est lisible), l'ordre entre connexions etant celui du relais.
 *
 * Exclus, et pourquoi : chase-hops, chase-one et chase-ldif-llll, parce que
 * le vrai client ne rend jamais la main (tue par le delai de 20 s de la
 * capture) des que la limite de 5 sauts est depassee ; le port, lui, rend la
 * main avec `ldap_result: Timed out (-5)` faute de reponse a attendre, ce
 * qu'un client interactif ne saurait pas faire sans bloquer le terminal.
 * Exclus aussi chase-sizelimit et chase-sub-bound : deux captures successives
 * du vrai client n'ordonnent pas pareil les reponses des deux serveurs (la
 * vitesse du client decide laquelle est lue d'abord), donc aucun rejeu
 * deterministe ne peut etre juste pour les deux.
 *
 * Temoin du laboratoire : « the replay refuses a request that differs from
 * the recorded one » modifie la base d'un scenario et exige un probleme de
 * requete.
 */
import { describe, it, expect } from 'vitest';
import {
  type Corpus, loadJson, replay, compareWithRecording,
} from './openldap-replay-support';

const corpus = loadJson<Corpus>('openldap-ldapsearch-chase-corpus.json');

describe('ldapsearch -C chases referrals like the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(19);
  });

  it('the replay refuses a request that differs from the recorded one', async () => {
    const scenario = corpus.scenarios.find((candidate) => candidate.name === 'chase-base');
    expect(scenario).toBeDefined();
    const altered = scenario!.args.map((arg) => (arg === 'ou=Remote,dc=a,dc=local' ? 'ou=Other,dc=a,dc=local' : arg));
    const outcome = await replay(scenario!, { args: altered, files: corpus.files });
    expect(compareWithRecording(outcome, scenario!, false).some((problem) => problem.startsWith('request mismatch'))).toBe(true);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      const outcome = await replay(scenario, { args: scenario.args, files: corpus.files });
      expect(compareWithRecording(outcome, scenario, false)).toEqual([]);
    });
  }
});
