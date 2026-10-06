/**
 * Sonde : `ldapsearch -Y GSSAPI` rejoue des executions du vrai client OpenLDAP
 * 2.5 (Cyrus SASL 2.1.28, MIT Kerberos 1.20.1, plugin libgssapiv2) face a un
 * vrai slapd dont la cle de service vient d'un vrai KDC MIT : memes octets sur
 * le fil (AP-REQ, jeton de choix de couche, trames wrap de la couche SASL),
 * meme sortie standard, meme sortie d'erreur, meme code de sortie, et le meme
 * cache d'identifiants apres l'execution.
 *
 * Le corpus (`openldap-ldapsearch-gssapi-corpus.json`) a ete capture a travers
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
 * 18 des 19 cas tombent. Passe avant comme apres `minssf300` : aucun
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
 * Non attestable ici : le jeu de greffons du paquet Ubuntu 22.04 simule face au
 * 2.1.28 d'Ubuntu 24.04 qui sert de reference ; GS2-KRB5 et GSS-SPNEGO, que le
 * vrai greffon annonce aussi, ne sont pas portes ; `-O passcred` (delegation)
 * est refuse explicitement ; le vrai client, devant un TGT expire, tente
 * d'abord un echange anonyme pour blinder sa requete (FAST) puis ecrit une
 * entree `refresh_time` dans le cache : ni l'un ni l'autre ne sont reproduits
 * (la sortie et le code de retour le sont, le cache n'est pas compare pour
 * ce scenario).
 */
import { describe, it, expect } from 'vitest';
import { replay, compareWithRecording, loadJson, type Scenario } from './openldap-replay-support';
import {
  RandomTape, recordedGssRandom, recordedKdcNonces, replayedKrb5, serviceSessionKey,
  type GssapiCorpus, type GssapiScenario,
} from './openldap-gssapi-replay-support';

const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-gssapi-corpus.json');
const PLUGINS = ['libgssapiv2.so', 'libplain.so', 'libdigestmd5.so', 'libcrammd5.so'];

const bytesOfHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));

async function run(scenario: GssapiScenario, args: readonly string[]) {
  const problems: string[] = [];
  const cacheBytes = scenario.cache === null ? null : bytesOfHex(corpus.caches[scenario.cache]);
  const key = cacheBytes === null ? null : serviceSessionKey(cacheBytes, ['ldap', 'vm']);
  const recorded = key === null || scenario.connections[0].transcript.length === 0 ? null : recordedGssRandom(scenario, key);
  const tape = new RandomTape([...recordedKdcNonces(scenario), ...(recorded?.chunks ?? [])], problems);
  const clock = recorded?.clockMicroseconds ?? scenario.clockMicroseconds;
  const krb5 = replayedKrb5(corpus, scenario, tape.take, () => clock);
  const asScenario: Scenario = {
    name: scenario.name, args, stdin: '', connections: scenario.connections,
    stdout: scenario.stdout, stderr: scenario.stderr, exitCode: scenario.exitCode,
  };
  const outcome = await replay(asScenario, {
    args, files: {}, saslPlugins: PLUGINS, random: tape.take, gss: krb5.gss, debugLevel: scenario.debugLevel,
  });
  const found = compareWithRecording({ ...outcome, problems: [...problems, ...outcome.problems] }, scenario, scenario.debugLevel !== undefined);
  if (scenario.cacheAfter !== undefined) {
    const written = krb5.files.get(scenario.cacheEnv.replace(/^FILE:/, ''));
    if (written === undefined || Buffer.from(written).toString('hex') !== scenario.cacheAfter) found.push('the credentials cache differs after the run');
  }
  if (tape.remaining !== 0) found.push(`${tape.remaining} recorded random draws were never consumed`);
  return found;
}

describe('ldapsearch -Y GSSAPI replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(19);
  });

  it('the replay refuses a request that differs from the recorded one', async () => {
    const scenario = corpus.scenarios.find((candidate) => candidate.name === 'default')!;
    const altered = scenario.args.flatMap((arg) => (arg === 'GSSAPI' ? [arg, '-O', 'maxssf=1'] : [arg]));
    const problems = await run(scenario, altered);
    expect(problems.some((problem) => problem.startsWith('request mismatch') || problem.startsWith('unexpected request'))).toBe(true);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await run(scenario, scenario.args)).toEqual([]);
    });
  }
});
