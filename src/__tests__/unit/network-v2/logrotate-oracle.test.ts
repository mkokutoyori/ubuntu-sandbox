/*
 * logrotate : le simulateur rejoue des scenarios enregistres avec le VRAI logrotate
 * 3.19.0 d'Ubuntu 22.04 (paquet 3.19.0-1ubuntu1.1, celui que la machine simulee declare), a la sortie et a l'arbre de fichiers
 * resultant pres.
 *
 * Chaque enregistrement (support/oracle/logrotate/*.json, produits par
 * scripts/oracle/record_logrotate.py) porte le scenario (arbre de depart, configuration,
 * fichier d'etat, arguments), l'heure exacte du lancement, la sortie fusionnee
 * stdout+stderr, le code de sortie et l'arbre apres execution (chemin, type, mode,
 * proprietaire, taille, contenu, decompresse si gzip). Le port du simulateur
 * (devices/linux/logrotate/) est celui des sources 3.19.0 et de ses correctifs Ubuntu (config.c, logrotate.c) ;
 * l'ancien `cmdLogrotate` de 90 lignes ne lisait ni la portee des directives, ni le
 * fichier d'etat, ni les echeances, et ignorait en silence plus de vingt directives
 * acceptees.
 *
 * Discriminee contre l'etat d'avant (git stash de src/network et src/bash) : les 201 cas
 * tombent, il n'y a aucun temoin parmi eux car l'ancien `cmdLogrotate` ne reproduisait la
 * sortie d'aucun scenario enregistre.
 *
 * Seules les secondes des dates du fichier d'etat sont normalisees : le simulateur et le
 * processus reel ne se lancent pas a la meme seconde.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { __resetSimulationClock } from '@/events/SimulationClock';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOracleLab, normaliseStateSeconds, runOracleCommand, snapshotOracleTree,
  type OracleRecord, type OracleTreeEntry,
} from './_helpers/logrotateOracle';

afterEach(() => { __resetSimulationClock(); });

const DIRECTORY = join(__dirname, '../../support/oracle/logrotate');
const records: OracleRecord[] = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.json'))
  .flatMap((name) => JSON.parse(readFileSync(join(DIRECTORY, name), 'utf8')) as OracleRecord[]);

const comparable = (entries: OracleTreeEntry[]): unknown[] => entries.map((entry) => ({
  path: entry.path,
  type: entry.type,
  mode: entry.mode,
  uid: entry.uid,
  gid: entry.gid,
  gzip: entry.gzip === true,
  target: entry.target,
  content: entry.path.endsWith('/status') ? normaliseStateSeconds(entry.content ?? undefined) : entry.content ?? undefined,
  contentSha256: entry.contentSha256,
  size: entry.type === 'file' && entry.gzip !== true ? entry.size : undefined,
}));

describe('logrotate contre le binaire reel', () => {
  for (const record of records) {
    it(record.name, async () => {
      const lab = buildOracleLab(record);
      const result = await runOracleCommand(lab, record);
      const maskPid = (text: string): string => text.replace(/\(pid \d+\)/g, '(pid N)');
      expect(maskPid(result.output.trimEnd())).toBe(maskPid(record.output.trimEnd()));
      expect(result.exit).toBe(record.exit);
      expect(comparable(snapshotOracleTree(lab.vfs))).toEqual(comparable(record.tree));
    });
  }
});
