/*
 * `show interfaces counters errors` nommait les ports en entier et
 * decalait ses colonnes, la ou `show interfaces counters`, sur la meme
 * machine, les abregeait.
 *
 * Mesure de depart, sur un commutateur Catalyst de 26 ports :
 *
 *   show interfaces counters          Fa0/1 … Gi0/2, colonnes alignees
 *   show interfaces counters errors   FastEthernet0/1 … GigabitEthernet0/2 ;
 *                                     a partir de FastEthernet0/10 le nom
 *                                     deborde de sa colonne et chaque
 *                                     compteur glisse d'un cran
 *
 * Deux abreviateurs existaient : celui de la vue LLDP (CiscoCommonShow),
 * complet — Te, Fo, Gi, Fa, Et, Se, Lo, Po, Vl — et celui du shell du
 * commutateur, qui n'en connaissait que trois. La table des erreurs n'en
 * lisait aucun.
 *
 * Un signalement parlait d'un « tableau duplique » pour `show interfaces
 * counters`. Mesure faite, par la session du terminal comme par
 * `executeCommand`, sous toutes les abreviations et a travers `--More--` :
 * la commande imprime un bloc d'ENTREE puis un bloc de SORTIE, chaque port
 * une fois dans chacun. C'est la forme d'IOS (Catalyst 6500 et 1300 :
 * InOctets/InUcastPkts/InMcastPkts/InBcastPkts, puis OutOctets/…), et le
 * cas qui le constate est un TEMOIN, pas une correction.
 *
 * Ecrite a l'aveugle contre cette forme, avant de lire le rendu.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 2 des 3 cas tombent — les noms abreges et l'alignement de la table des
 * erreurs. Le troisieme, les deux blocs de `show interfaces counters`,
 * passe des deux cotes : c'est le TEMOIN de la forme d'IOS.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function show(command: string): Promise<string[]> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 26, 0, 0);
  await sw.executeCommand('enable');
  await sw.executeCommand('terminal length 0');
  return (await sw.executeCommand(command)).split('\n');
}

const portColumn = (lines: string[]): string[] =>
  lines.filter((l) => /^\S/.test(l) && !/^Port\b/.test(l)).map((l) => l.split(/\s+/)[0]);

describe('`show interfaces counters errors` parle comme `show interfaces counters`', () => {
  it('les ports portent leur nom abrege', async () => {
    const ports = portColumn(await show('show interfaces counters errors'));

    expect(ports).toContain('Fa0/1');
    expect(ports).toContain('Gi0/1');
    expect(ports.some((p) => /Ethernet/.test(p))).toBe(false);
  }, 30000);

  it('chaque ligne finit sous la derniere colonne de l\'en-tete', async () => {
    const lines = await show('show interfaces counters errors');
    const width = lines[0].length;

    for (const row of lines.slice(1).filter((l) => l.trim())) expect(row.length).toBe(width);
  }, 30000);
});

describe('`show interfaces counters` — la forme d\'IOS, un bloc par sens', () => {
  it('deux blocs, et chaque port une seule fois dans chacun — TEMOIN', async () => {
    const lines = await show('show interfaces counters');
    const blocks = lines.join('\n').split('\n\n');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/^Port\s+InOctets\s+InUcastPkts\s+InMcastPkts\s+InBcastPkts$/m);
    expect(blocks[1]).toMatch(/^Port\s+OutOctets\s+OutUcastPkts\s+OutMcastPkts\s+OutBcastPkts$/m);
    for (const block of blocks) {
      const ports = portColumn(block.split('\n'));
      expect(new Set(ports).size).toBe(ports.length);
      expect(ports).toHaveLength(26);
    }
  }, 30000);
});
