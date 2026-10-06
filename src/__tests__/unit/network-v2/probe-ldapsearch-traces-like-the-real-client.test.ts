/**
 * Sonde : `ldapsearch -d` ecrit sur la sortie d'erreur la meme trace que le
 * vrai client OpenLDAP, ligne pour ligne. Le port reprend la couche libldap /
 * liblber avec ses compteurs de references (`ldap_new_connection`,
 * `ldap_free_connection`, `ldap_return_request`), la lecture `ber_get_next`
 * par 8 octets puis le reste, `ber_scanf` et `ber_dump`, le tableau des
 * connexions et des requetes en cours, la boucle `wait4msg`/`try_read1msg`
 * et ses decomptes, la chasse des referrals et la copie des controles lus.
 *
 * Le corpus (`openldap-ldapsearch-trace-corpus.json`) contient 447 traces
 * du vrai client (clone du depot officiel, branche 2.5, compile ici) sur les
 * scenarios des deux corpus de rejeu : les niveaux 1, 2 et 4 sur tous, les
 * niveaux 7, 16 et 23 (combinaisons des precedents, dont BER) sur 18
 * scenarios representatifs. Une trace dont les octets recus different de la
 * capture sans `-d` (l'etat du serveur a change entre-temps, par exemple le
 * `contextCSN`) porte ses propres connexions. Les pointeurs, le port local,
 * la date de derniere utilisation et le decompte de `wait4msg` (microsecondes
 * restantes, dependantes du temps reel) sont masques des deux cotes.
 *
 * Mesure avant la creation du module : l'ancien port accepte `-d` sans rien
 * ecrire (273 des 405 traces du premier corpus ont une sortie d'erreur vide
 * cote port) ; 70 des 405 passent avant et apres, tous des cas ou le vrai
 * client n'ecrit aucune trace (erreur d'option ou de connexion avant la
 * creation de la session : bad-E, bad-P, bad-d, bad-e, bad-l, bad-z, badopt,
 * connfail, deref-bad, missing-arg, scope-bad, x-and-D...), temoins que le
 * laboratoire compare bien. Les 42 traces du corpus de chasse tombent
 * toutes avant.
 *
 * Exclus, et pourquoi : `-V` (banniere du paquet Ubuntu non attestable ici),
 * `-E sync=rp` (ne rend jamais la main), et les traces SASL/TLS (le vrai
 * binaire de reference est compile sans SASL ni TLS, donc leurs lignes
 * GnuTLS ou Cyrus ne peuvent pas etre attestees).
 *
 * Temoin du laboratoire : « the trace of another level is refused » rejoue
 * un scenario au niveau 2 et le compare a la trace du niveau 1.
 */
import { describe, it, expect } from 'vitest';
import {
  type Corpus, type TraceCorpus, loadJson, replay, compareWithRecording,
} from './openldap-replay-support';

const corpora: Record<string, Corpus> = {
  'openldap-ldapsearch-corpus.json': loadJson<Corpus>('openldap-ldapsearch-corpus.json'),
  'openldap-ldapsearch-chase-corpus.json': loadJson<Corpus>('openldap-ldapsearch-chase-corpus.json'),
};
const { traces } = loadJson<TraceCorpus>('openldap-ldapsearch-trace-corpus.json');

function scenarioOf(trace: TraceCorpus['traces'][number]): Corpus['scenarios'][number] {
  const corpus = corpora[trace.corpus];
  const scenario = corpus.scenarios.find((candidate) => candidate.name === trace.scenario)!;
  return { ...scenario, connections: trace.connections ?? scenario.connections };
}

describe('ldapsearch -d traces like the real OpenLDAP client', () => {
  it('the corpus carries the recorded traces', () => {
    expect(traces.length).toBe(447);
  });

  it('the trace of another level is refused', async () => {
    const trace = traces.find((candidate) => candidate.scenario === 'basic-anon' && candidate.level === 1)!;
    const scenario = scenarioOf(trace);
    const outcome = await replay(scenario, { args: scenario.args, debugLevel: 2, files: corpora[trace.corpus].files });
    const recorded = { stdout: scenario.stdout, stderr: trace.stderr, exitCode: scenario.exitCode };
    expect(compareWithRecording(outcome, recorded, true).some((problem) => problem.startsWith('stderr differs'))).toBe(true);
  });

  for (const trace of traces) {
    it(`scenario ${trace.scenario} at -d ${trace.level} traces like the real client`, async () => {
      const scenario = scenarioOf(trace);
      const outcome = await replay(scenario, {
        args: scenario.args, debugLevel: trace.level, files: corpora[trace.corpus].files,
      });
      const recorded = {
        stdout: trace.stdout ?? scenario.stdout,
        stderr: trace.stderr,
        exitCode: trace.exitCode ?? scenario.exitCode,
      };
      expect(compareWithRecording(outcome, recorded, true)).toEqual([]);
    });
  }
});
