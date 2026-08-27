/**
 * `vlan <id>` — la porte du sous-mode de declaration de VLAN.
 *
 * Elle a la meme forme que `interface` et `line` : elle change de mode,
 * elle se tape aussi bien depuis la configuration globale que depuis le
 * sous-mode ou elle mene, et son argument est borne. C'est donc la
 * troisieme famille de la meme sorte, et ce qui est mesure ici est
 * qu'elle repond LA MEME CHOSE des deux origines.
 *
 * `vlan 10,20` et `vlan 10-12` en creent plusieurs d'un coup : c'est la
 * forme qu'un cours utilise pour monter un laboratoire en une ligne, et
 * elle ne fait PAS entrer dans le sous-mode sur une vraie machine —
 * on ne nomme pas trois VLAN a la fois.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  getPrompt?(): string;
}

let serial = 0;

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized|not allowed|Invalid/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

const DEPUIS_LA_CONFIGURATION = 'depuis la configuration globale';
const DEPUIS_UN_VLAN = 'depuis un VLAN deja selectionne';
const ORIGINES = [DEPUIS_LA_CONFIGURATION, DEPUIS_UN_VLAN] as const;

async function depuis(origine: string): Promise<Cli> {
  return origine === DEPUIS_UN_VLAN ? commutateur('vlan 99') : commutateur();
}

describe('la porte entre dans le sous-mode', () => {
  it.each(ORIGINES)('`vlan 10` mene a `config-vlan` — %s', async (origine) => {
    const sw = await depuis(origine);

    expect(refuse(await sw.executeCommand('vlan 10')), origine).toBe(false);
    expect(sw.getPrompt?.() ?? '', origine).toMatch(/config-vlan/);
  });

  it.each(ORIGINES)('`name VENTES` y est accepte et rendu — %s', async (origine) => {
    const sw = await depuis(origine);
    await sw.executeCommand('vlan 10');

    expect(refuse(await sw.executeCommand('name VENTES')), origine).toBe(false);
    expect(await configuration(sw), origine).toContain('VENTES');
  });

  it.each(ORIGINES)('le VLAN cree apparait dans `show vlan brief` — %s',
    async (origine) => {
      const sw = await depuis(origine);
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('name VENTES');
      await sw.executeCommand('end');

      const vue = await sw.executeCommand('show vlan brief');
      expect(vue, origine).toContain('10');
      expect(vue, origine).toContain('VENTES');
    });
});

describe('l identifiant est borne', () => {
  it.each(ORIGINES)('`vlan 4095` est refuse — %s', async (origine) => {
    const sw = await depuis(origine);

    expect(refuse(await sw.executeCommand('vlan 4095')), origine).toBe(true);
  });

  it.each(ORIGINES)('`vlan 0` est refuse — %s', async (origine) => {
    const sw = await depuis(origine);

    expect(refuse(await sw.executeCommand('vlan 0')), origine).toBe(true);
  });

  it.each(ORIGINES)('`vlan zorglub` est refuse — %s', async (origine) => {
    const sw = await depuis(origine);

    expect(refuse(await sw.executeCommand('vlan zorglub')), origine).toBe(true);
  });

  it.each(ORIGINES)('`vlan` seul est incomplet — %s', async (origine) => {
    const sw = await depuis(origine);

    expect(await sw.executeCommand('vlan'), origine).toContain('Incomplete');
  });

  /*
   * Un identifiant refuse ne doit pas non plus DEPLACER la session :
   * nommer un VLAN qui n'existe pas nommerait celui d'avant.
   */
  it('un identifiant refuse laisse la session ou elle etait', async () => {
    const sw = await commutateur('vlan 99');
    await sw.executeCommand('vlan 4095');
    await sw.executeCommand('name TOUJOURS-99');

    expect(await configuration(sw)).toContain('TOUJOURS-99');
  });
});

describe('la forme en LISTE cree plusieurs VLAN', () => {
  it.each(['vlan 10,20,30', 'vlan 10-12'])('`%s` les cree tous', async (ligne) => {
    const sw = await commutateur();
    await sw.executeCommand(ligne);
    await sw.executeCommand('end');

    const vue = await sw.executeCommand('show vlan brief');
    const attendus = ligne.includes('-') ? ['10', '11', '12'] : ['10', '20', '30'];
    for (const id of attendus) expect(vue, `${ligne} / ${id}`).toMatch(new RegExp(`^${id}\\s`, 'm'));
  });

  /*
   * On ne nomme pas trois VLAN a la fois : la forme en liste ne fait
   * donc pas entrer dans le sous-mode.
   */
  it('et elle ne fait PAS entrer dans le sous-mode', async () => {
    const sw = await commutateur();
    await sw.executeCommand('vlan 10,20,30');

    expect(sw.getPrompt?.() ?? '').not.toMatch(/config-vlan/);
  });
});

describe('la negation', () => {
  it('`no vlan 10` le retire', async () => {
    const sw = await commutateur('vlan 10', 'name VENTES', 'exit', 'no vlan 10');
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show vlan brief')).not.toContain('VENTES');
  });

  it('`no vlan 1` est refuse — le VLAN par defaut ne se supprime pas', async () => {
    const sw = await commutateur();

    expect(await sw.executeCommand('no vlan 1')).toMatch(/may not be deleted|Default VLAN/i);
  });

  it('`no vlan 4095` est refuse comme la forme positive', async () => {
    const sw = await commutateur();

    expect(refuse(await sw.executeCommand('no vlan 4095'))).toBe(true);
  });
});

describe('l aide de la famille', () => {
  it.each(ORIGINES)('`vlan ?` annonce la plage — %s', async (origine) => {
    const sw = await depuis(origine);

    expect(sw.cliHelp('vlan '), origine).toMatch(/<1-4094>/);
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const sw = await commutateur();
    const nues: string[] = [];
    for (const amont of ['vlan ', 'no vlan ']) {
      for (const ligne of sw.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
