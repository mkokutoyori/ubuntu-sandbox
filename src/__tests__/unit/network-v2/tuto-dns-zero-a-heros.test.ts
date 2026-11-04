/*
 * Le tutoriel « DNS de zero a heros » (docs/tutoriel-dns-zero-a-heros.md), rejoue sur le laboratoire Banque Horizon (labs/dns-agence-bancaire, douze equipements).
 *
 * Les sorties que le tutoriel montre sont celles du fichier support/tuto/dns-zero-a-heros-captures.json : chaque etape (equipement, commande, sortie) y a ete mesuree dans le laboratoire, dans l'ordre
 * ou le tutoriel la fait taper. Trois tests :
 * 1. chaque groupe d'etapes est rejoue dans un laboratoire neuf et ce que la machine affiche est compare, etape par etape, a la capture, apres avoir masque ce qui change d'une execution a l'autre
 *    (l'identifiant d'une question, la duree, la date, les horodatages, ports et numeros de sequence d'une capture de paquets, les chiffres d'un vidage de cache, la date d'une page web) ;
 * 2. les parties VI a XI inserent les sorties de la capture : pour chaque etape que le tutoriel montre en entier (la liste `shown` du fichier), la premiere ligne de la sortie figure dans le tutoriel ;
 * 3. les parties I a V, ecrites a la main, ne montrent que des lignes de la capture : chaque bloc de resultat est couvert par la sortie d'UNE etape (deux blocs reunissent volontairement les sorties de
 *    plusieurs commandes courtes : la liste de `getent hosts` et les `+short` du TP 11).
 * Groupes : A = parties I a V (poser une question, descendre l'arbre, les enregistrements), H = partie VI, I = partie VII, J = partie VIII, K = parties IX et X, L = partie XI, M = `host` et `dig +search`,
 * N = les sorties de la partie V qui ne sont pas dans A.
 * Mesure avant les corrections de la meme livraison (git stash push -- src/network src/powershell) : 6 des 10 tests tombent, les groupes H (23 etapes differentes), I (2), J (2), K (6), L (9) et M (5), soit 47 etapes ;
 * les groupes A et N (parties I a V, qui ne dependent d'aucune correction) et les deux tests qui lisent le tutoriel passent des deux cotes. Chaque correction a son propre decompte dans sa sonde `probe-*` ou son test `*-oracle`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

interface Step { readonly id: string; readonly dev: string; readonly kind: 'sh' | 'ps'; readonly cmd: string; readonly output: string }

const captures = JSON.parse(readFileSync(new URL('../../support/tuto/dns-zero-a-heros-captures.json', import.meta.url), 'utf8')) as { readonly shown: readonly string[]; readonly groups: Readonly<Record<string, readonly Step[]>> };
const tutorial = readFileSync(new URL('../../../../docs/tutoriel-dns-zero-a-heros.md', import.meta.url), 'utf8');

const CLOCK = /\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g;

function masked(text: string, digits = false, spaces = false): string[] {
  return text.replace(/\s+$/, '').split('\n').map((line) => (spaces ? line.replace(/\s+/g, ' ') : digits ? line.replace(/\d+/g, '#') : line).trimEnd()
    .replace(/\bid: \d+/g, 'id: N')
    .replace(/Query time: \d+ msec/g, 'Query time: N msec')
    .replace(/;; WHEN: .*/g, ';; WHEN: D')
    .replace(/\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}:\d{2}\.\d+/g, 'D')
    .replace(/[A-Z][a-z]{2} +\d+ \d{2}:\d{2}:\d{2}/g, 'D')
    .replace(/\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M/g, 'D')
    .replace(/\bclient @0x[0-9a-f]+ ([0-9.]+)#\d+/g, 'client @0x $1#P')
    .replace(/\[\d+\]( |$)/g, '[J]$1')
    .replace(/^(Last-Modified|ETag|Date): .*/g, '$1: V')
    .replace(CLOCK, 'T')
    .replace(/\bT [AP]M\b/g, 'T')
    .replace(/\b(seq|ack) \d+(:\d+)?/g, '$1 S')
    .replace(/\bTS val \d+ ecr \d+/g, 'TS val V ecr V')
    .replace(/\b(\d+\.\d+\.\d+\.\d+)\.\d{4,5}( >|:)/g, '$1.P$2')
    .replace(/\b(win|length) \d+/g, '$1 W')
    .replace(/(\.\d+: )\d+(\+?) ((\[\d+au\] )?[A-Z]+\?)/g, '$1Q$2 $3')
    .replace(/(length W) \d+( [A-Z]+\?)/g, '$1 Q$2')
    .replace(/\b\d+(\*?-?\|?) (\d+\/\d+\/\d+)/g, 'N$1 $2')
    .replace(/ (\d{1,2}(\.\d+)?) ?ms\b/g, ' ms'));
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

describe('le tutoriel DNS de zero a heros, rejoue sur le laboratoire Banque Horizon', () => {
  for (const [group, steps] of Object.entries(captures.groups)) {
    it(`groupe ${group} : les ${steps.length} etapes affichent ce que le tutoriel montre`, async () => {
      const lab = await buildDnsAgenceBancaire();
      const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
      const differing: string[] = [];
      for (const step of steps) {
        const device = devices.get(step.dev)!;
        const output = step.kind === 'ps' ? await lab.bench.powershell(device, step.cmd) : await lab.bench.shell(device, step.cmd);
        const digits = step.cmd.includes('named_dump');
        const spaces = step.output.includes('Timestamp');
        if (JSON.stringify(masked(output, digits, spaces)) !== JSON.stringify(masked(step.output, digits, spaces))) {
          differing.push(`${step.id} (${step.dev}) : ${step.cmd.split('\n')[0]}\n--- attendu\n${masked(step.output, digits, spaces).join('\n')}\n--- obtenu\n${masked(output, digits, spaces).join('\n')}`);
        }
      }
      expect(differing, differing.join('\n\n')).toEqual([]);
    }, 900000);
  }

  it('les parties VI a XI montrent la sortie des etapes qu\'elles inserent', () => {
    const shown = new Set(masked(tutorial));
    const byId = new Map<string, Step>();
    for (const steps of Object.values(captures.groups)) for (const step of steps) byId.set(step.id, step);
    const missing: string[] = [];
    for (const id of captures.shown) {
      const step = byId.get(id)!;
      const digits = step.cmd.includes('named_dump');
      const first = masked(step.output, digits).find((line) => line.trim() !== '');
      if (first !== undefined && !(digits ? new Set(masked(tutorial, true)) : shown).has(first)) missing.push(`${id} : ${first}`);
    }
    expect(captures.shown.length).toBeGreaterThan(100);
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('chaque bloc de resultat des parties I a V est couvert par la sortie d\'une seule etape', () => {
    const start = tutorial.indexOf('\n# Partie I \u2014');
    const end = tutorial.indexOf('\n# Partie VI \u2014');
    const outputs = Object.values(captures.groups).flat().map((step) => new Set(masked(step.output)));
    const blocks: string[][] = [];
    let current: string[] | null = null;
    for (const line of tutorial.slice(start, end).split('\n')) {
      if (line.startsWith('```')) {
        if (current === null) current = [];
        else { blocks.push(current); current = null; }
      } else if (current !== null) current.push(line);
    }
    const combined = new Set(['10.20.20.10     intranet.horizon.local', '"v=spf1 mx -all"']);
    const uncovered: string[] = [];
    for (const block of blocks) {
      if (block[0]?.startsWith('# sur') || block.some((line) => /[\u2502\u2514\u251c\u250c\u2510\u2518\u252c\u2534\u2571\u2572\u25b6\u25c0\u2190]/.test(line))) continue;
      const lines = masked(block.filter((line) => line.trim() !== '').join('\n'));
      if (lines.length === 0 || combined.has(lines[0])) continue;
      if (!outputs.some((pool) => lines.every((line) => pool.has(line)))) uncovered.push(lines.slice(0, 4).join('\n'));
    }
    expect(blocks.length).toBeGreaterThan(50);
    expect(uncovered, uncovered.join('\n---\n')).toEqual([]);
  });
});
