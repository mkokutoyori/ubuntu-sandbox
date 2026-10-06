/**
 * Sonde : `ldapsearch -d` avec un mecanisme SASL ecrit sur la sortie d'erreur
 * la meme trace que le vrai client OpenLDAP compile avec Cyrus SASL, ligne
 * pour ligne : `ldap_sasl_interactive_bind`, `ldap_int_sasl_bind`,
 * `ldap_int_sasl_open`, `sasl_client_step`, `ldap_pvt_sasl_generic_install`,
 * l'interrogation `supportedSASLMechanisms` (`ldap_search`, `ldap_get_values`),
 * les `ldap_msgfree` de la boucle de l'outil et, au niveau 2, les deux
 * couches de la pile de tampons (`sasl_generic_read/write` pour les paquets
 * chiffres, `ldap_read/write` pour les messages en clair).
 *
 * Le corpus (`openldap-ldapsearch-sasl-trace-corpus.json`) contient 339
 * traces du vrai client aux niveaux 1, 2 et 16 sur les scenarios du corpus de
 * rejeu SASL ; chaque trace porte ses propres connexions car les nonces
 * different d'une execution a l'autre. Les pointeurs, le port local, la date
 * de derniere utilisation et le decompte de `wait4msg` sont masques des deux
 * cotes.
 *
 * Mesure avant la creation du module (port sans libsasl2) : 331 des 341 cas
 * tombent. Passent avant et apres : le decompte du corpus et les neuf traces
 * des trois scenarios `-P 2` aux trois niveaux, ou le client refuse le bind
 * avant toute connexion (non-regression).
 *
 * Temoin du laboratoire : « the trace of another level is refused » rejoue un
 * scenario DIGEST-MD5 au niveau 2 et le compare a la trace du niveau 1.
 */
import { describe, it, expect } from 'vitest';
import {
  type Corpus, type TraceCorpus, loadJson, replay, compareWithRecording,
} from './openldap-replay-support';

const corpus = loadJson<Corpus>('openldap-ldapsearch-sasl-corpus.json');
const { traces } = loadJson<TraceCorpus>('openldap-ldapsearch-sasl-trace-corpus.json');

function scenarioOf(trace: TraceCorpus['traces'][number]): Corpus['scenarios'][number] {
  const scenario = corpus.scenarios.find((candidate) => candidate.name === trace.scenario)!;
  return { ...scenario, connections: trace.connections ?? scenario.connections };
}

function recordedOf(trace: TraceCorpus['traces'][number]): { stdout: string; stderr: string; exitCode: number } {
  const scenario = corpus.scenarios.find((candidate) => candidate.name === trace.scenario)!;
  return {
    stdout: trace.stdout ?? scenario.stdout, stderr: trace.stderr, exitCode: trace.exitCode ?? scenario.exitCode,
  };
}

describe('ldapsearch SASL -d traces like the real OpenLDAP client', () => {
  it('the corpus carries the recorded traces', () => {
    expect(traces.length).toBe(339);
  });

  it('the trace of another level is refused', async () => {
    const trace = traces.find((candidate) => candidate.scenario === 'digest-default' && candidate.level === 1)!;
    const scenario = scenarioOf(trace);
    const outcome = await replay(scenario, { args: scenario.args, debugLevel: 2, files: corpus.files });
    expect(compareWithRecording(outcome, recordedOf(trace), true).some((problem) => problem.startsWith('stderr differs'))).toBe(true);
  });

  for (const trace of traces) {
    it(`scenario ${trace.scenario} at -d ${trace.level} traces like the real client`, async () => {
      const scenario = scenarioOf(trace);
      const outcome = await replay(scenario, { args: scenario.args, debugLevel: trace.level, files: corpus.files });
      expect(compareWithRecording(outcome, recordedOf(trace), true)).toEqual([]);
    });
  }
});
