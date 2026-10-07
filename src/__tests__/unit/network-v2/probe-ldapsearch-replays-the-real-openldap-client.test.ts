/**
 * Sonde : le port de `ldapsearch` rejoue 130 executions du vrai client OpenLDAP
 * (clone du depot officiel, branche 2.5, compile ici, face a un vrai slapd) et
 * produit exactement les memes octets : la meme requete sur le fil (BER,
 * numeros de message, ordre des controles), la meme sortie standard, le meme
 * message d'erreur et le meme code de sortie.
 *
 * Le corpus (`openldap-ldapsearch-corpus.json`) a ete capture a travers un
 * relais qui enregistre chaque PDU. Les reponses du serveur sont celles du
 * vrai slapd ; les requetes du vrai client servent d'etalon octet par octet.
 * Deux serveurs : le premier sans overlay (81 cas : portees, filtres, dont -f
 * et l'entree standard, -L/-LL/-LLL, repliement LDIF, valeurs binaires et
 * `:<` vers fichier temporaire, -u, -S, deref, referrals et -M, controles
 * pr, relax, noop, postread, sessiontracking et critiques inconnus, -z/-l,
 * -y, -W (invite sur la sortie d'erreur, mot de passe lu sur l'entree
 * standard faute de terminal, fin de fichier, retour chariot), -x avec -D,
 * messages de getopt de la glibc) ; le second avec les
 * overlays sssvlv, ppolicy, memberof, valsort, deref et syncprov (49 cas :
 * tri cote serveur, VLV et son invite interactive, ppolicy, deref, memberOf,
 * matched values, assertion, authzid/proxydn, controles Microsoft et
 * generiques `-E oid=:hex`).
 *
 * Mesure avant la creation du module : les 130 cas tombent, `ldapsearch.ts`
 * n'existe pas. Aucun cas ne passe avant et apres : le module est neuf.
 *
 * Temoin du laboratoire : « the replay refuses a request that differs from
 * the recorded one » rejoue le premier scenario avec une base de recherche
 * modifiee et exige un probleme de requete ; sans lui, un rejeu qui ne
 * comparerait rien passerait pour juste.
 *
 * Exclus du corpus, et pourquoi : `-V`, parce que le binaire de reference est
 * compile depuis les sources (2.5.X, date de compilation), pas le paquet
 * Ubuntu 22.04 ; la banniere du paquet (version Debian, hote de construction)
 * ne peut pas etre attestee depuis cet environnement, et le simulateur
 * affiche celle qu'il connait de memoire. Exclu aussi : `-E sync=rp`
 * (refreshAndPersist), qui ne rend jamais la main et que le vrai client ne
 * quitte que tue par le delai de la capture.
 */
import { describe, it, expect } from 'vitest';
import {
  type Corpus, loadJson, replay, compareWithRecording,
} from './openldap-replay-support';

const corpus = loadJson<Corpus>('openldap-ldapsearch-corpus.json');

async function problemsOf(scenario: Corpus['scenarios'][number], args: readonly string[]): Promise<string[]> {
  const outcome = await replay(scenario, { args, files: corpus.files });
  return compareWithRecording(outcome, scenario, false);
}

describe('ldapsearch replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(130);
  });

  it('the replay refuses a request that differs from the recorded one', async () => {
    const scenario = corpus.scenarios.find((candidate) => candidate.name === 'basic-anon');
    expect(scenario).toBeDefined();
    const altered = scenario!.args.map((arg) => (arg === 'dc=corp,dc=local' ? 'dc=other,dc=local' : arg));
    const problems = await problemsOf(scenario!, altered);
    expect(problems.some((problem) => problem.startsWith('request mismatch'))).toBe(true);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await problemsOf(scenario, scenario.args)).toEqual([]);
    });
  }
});
