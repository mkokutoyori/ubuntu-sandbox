/**
 * Sonde : `ldapsearch -Y GSSAPI` rejoue des executions du vrai client OpenLDAP
 * 2.5 (Cyrus SASL 2.1.28, MIT Kerberos 1.20.1, plugin libgssapiv2) face a un
 * vrai slapd dont la cle de service vient d'un vrai KDC MIT : memes octets sur
 * le fil (AP-REQ, jeton de choix de couche, trames wrap de la couche SASL),
 * meme sortie standard, meme sortie d'erreur, meme code de sortie, et le meme
 * cache d'identifiants apres l'execution.
 *
 * Le corpus (`openldap-ldapsearch-gssapi-corpus.json`, avec les traces -d 1, 2,
 * 4, 16 et 20) a ete capture a travers
 * un relais qui enregistre chaque PDU LDAP et chaque echange avec le KDC. Les
 * entiers aleatoires du client (sous-cle, numero de sequence, confondeurs) et
 * l'heure de l'authentifiant, ainsi que les nonces des requetes au KDC, sont relus en ouvrant la capture avec la cle de
 * session du billet de service : le generateur et l'horloge du simulateur
 * rendent les memes octets, le reste est calcule. Les echanges avec le KDC
 * (erreurs seulement) sont rejoues : leurs requetes ne sont pas comparees, car
 * le vrai client les blinde avec FAST (RFC 6113), que le KDC du simulateur ne
 * parle pas ; la reponse enregistree est celle que le simulateur decode.
 *
 * Mesure avant la creation du mecanisme (liste de greffons sans `libgssapiv2`) :
 * 21 des 22 cas tombent. Passe avant comme apres `minssf300` : aucun
 * mecanisme ne peut offrir 300 bits, donc « No worthy mechs found » est la
 * reponse du client reel avec ou sans greffon (non-regression). Temoin du
 * laboratoire : « the replay refuses a request that differs from the recorded
 * one » change la couche choisie (maxssf) d'un scenario et exige un probleme
 * de requete.
 *
 * Les drapeaux du jeton (MUTUAL, SEQUENCE, INTEG, CONF) suivent le greffon
 * Debian/Ubuntu, que deux correctifs (channel binding, maxssf 0) ecartent du
 * greffon amont : INTEG toujours demande, CONF seulement au-dela de 1 bit, et
 * l'option qui retire les drapeaux automatiques de MIT quand maxssf est
 * inferieur ou egal au SSF externe.
 *
 * Le scenario `expired` a ete enregistre de nouveau avec la requete AS et le
 * cache final : avant la correction du client Kerberos, 1 des 24 cas tombait
 * (requete AS jamais envoyee, cache sans `refresh_time`) ; les 23 autres
 * passent avant comme apres, ils servent de temoins de non-regression.
 *
 * Non attestable ici : le jeu de greffons du paquet Ubuntu 22.04 simule face au
 * 2.1.28 d'Ubuntu 24.04 qui sert de reference ; GS2-KRB5, que le vrai greffon
 * annonce aussi, n'est pas porte ; `-O passcred` (delegation) est refuse
 * explicitement. Devant un TGT expire ou a moins de 30 secondes de
 * l'expiration, le vrai client envoie une requete AS sans cle (le client
 * keytab par defaut n'existe pas) et note `refresh_time` dans le cache : les
 * deux sont reproduits, la requete AS est comparee champ a champ et le cache
 * octet pour octet. Les requetes TGS ne sont comparees que par options, noms
 * et domaine : le vrai client y joint un PA-FX-FAST et propose huit types de
 * chiffrement, le simulateur n'implemente ni FAST ni d'autre chiffrement
 * qu'AES256.
 */
import { describe, it, expect } from 'vitest';
import { loadJson } from './openldap-replay-support';
import { replayGssapiScenario, type GssapiCorpus } from './openldap-gssapi-replay-support';

const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-gssapi-corpus.json');
describe('ldapsearch -Y GSSAPI replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(22);
  });

  it('the replay refuses a request that differs from the recorded one', async () => {
    const scenario = corpus.scenarios.find((candidate) => candidate.name === 'default')!;
    const altered = scenario.args.flatMap((arg) => (arg === 'GSSAPI' ? [arg, '-O', 'maxssf=1'] : [arg]));
    const problems = await replayGssapiScenario(corpus, scenario, altered);
    expect(problems.some((problem) => problem.startsWith('request mismatch') || problem.startsWith('unexpected request'))).toBe(true);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await replayGssapiScenario(corpus, scenario, scenario.args)).toEqual([]);
    });
  }
});
