/**
 * `HOST 'commande'` de RMAN etait refuse (« unknown command »). Il execute la commande sur le systeme d'exploitation de la
 * machine qui porte la session (la meme que le shell : memes fichiers, meme repertoire courant) et ecrit sa sortie, puis la
 * ligne `host command complete`. Aucun faux resultat : la sortie est celle de la commande.
 * Non source (TODO.md [rman]) : `HOST` sans commande (ouvre un shell interactif) reste refuse.
 *
 * Discrimine par `git stash` sur src : 2 des 3 cas tombent avant. TEMOIN : une commande RMAN voisine continue de marcher.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SELECT 1 FROM dual;');
});

const rman = (...lines: string[]): string => lab.rman(lab.prod, ['CONNECT TARGET /;', ...lines].join('\n'));

describe('HOST', () => {
  it('TEMOIN — a neighbouring command still works', () => {
    expect(rman('LIST BACKUP SUMMARY;')).not.toContain('RMAN-01009');
  });

  it('prints the output of the command, then host command complete', () => {
    const out = rman("HOST 'echo from-the-host';");
    expect(out).toContain('from-the-host');
    expect(out.indexOf('from-the-host')).toBeLessThan(out.indexOf('host command complete'));
  });

  it('runs on the machine that carries the session: it sees the files the machine holds', async () => {
    await lab.prod.executeCommand("sh -c 'echo marker-line > /tmp/host-marker.txt'");
    expect(rman("HOST 'cat /tmp/host-marker.txt';")).toContain('marker-line');
  });
});
