/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `vlan <id>` entre dans le sous-mode de declaration d'un VLAN et le
 * CREE s'il n'existe pas ; `name <mot>` le nomme ; `no vlan <id>` le
 * supprime. La plage utile est 1-4094, le VLAN 1 ne se supprime pas, et
 * `show vlan brief` rend la table. Une plage (`vlan 10-12`) declare
 * plusieurs VLAN d'un coup.
 *
 * Un routeur n'a PAS cette commande en configuration globale : c'est
 * une famille de commutateur, et la parite entre plateformes consiste
 * ici a ce que le routeur la REFUSE.
 *
 * Elle N'A DEMANDE AUCUN CORRECTIF : la famille etait deja migree au
 * socle et deja fidele. C'est donc un garde-fou, pas une sonde de
 * defaut, et le seul ecart mesure venait de la sonde elle-meme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPrompt(): string;
}

/**
 * Le refus de cette famille est PLUS PRECIS que le caret generique :
 * un Catalyst repond `% Invalid VLAN ID` pour un identifiant hors
 * plage comme pour un mot qui n'est pas un nombre. La sonde avait
 * d'abord exige le caret, et c'etait elle qui avait tort — deux refus
 * pour une saisie seraient un refus de trop, et c'est le plus precis
 * qui doit parler.
 */
const REFUS = /Invalid input|Incomplete command|Unknown command|Invalid VLAN ID/;

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

async function enConfig(d: Cli): Promise<Cli> {
  await taper(d, ['enable', 'configure terminal']);
  return d;
}

describe('`vlan <id>` cree le VLAN et entre dans son sous-mode', () => {
  it('l invite passe en (config-vlan)', async () => {
    const sw = await enConfig(catalyst());
    await sw.executeCommand('vlan 10');

    expect(sw.getPrompt()).toMatch(/\(config-vlan\)#$/);
  });

  it('le VLAN parait dans `show vlan brief`', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 10', 'exit', 'end']);

    expect(await sw.executeCommand('show vlan brief')).toMatch(/^10\s/m);
  });

  it('`name` le nomme, et le nom se relit', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 10', 'name VENTES', 'exit', 'end']);

    expect(await sw.executeCommand('show vlan brief')).toContain('VENTES');
  });

  it('le nom garde sa CASSE — c est une donnee', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 10', 'name Ventes-RH', 'exit', 'end']);

    expect(await sw.executeCommand('show vlan brief')).toContain('Ventes-RH');
  });

  it('`exit` revient en configuration globale', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 10', 'exit']);

    expect(sw.getPrompt()).toMatch(/\(config\)#$/);
  });

  it('un VLAN declare se relit dans la configuration', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 10', 'name VENTES', 'exit', 'end']);

    expect(await sw.executeCommand('show running-config')).toMatch(/vlan 10/);
  });
});

describe('`no vlan <id>` le supprime', () => {
  it('il disparait de la table', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 10', 'exit', 'no vlan 10', 'end']);

    expect(await sw.executeCommand('show vlan brief')).not.toMatch(/^10\s/m);
  });

  it('le VLAN 1 ne se supprime pas', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['no vlan 1', 'end']);

    expect(await sw.executeCommand('show vlan brief')).toMatch(/^1\s/m);
  });
});

describe('la plage 1-4094 est APPLIQUEE, pas seulement annoncee', () => {
  const HORS = ['0', '4095', '9999'];

  for (const id of HORS) {
    it(`\`vlan ${id}\` est refuse`, async () => {
      const sw = await enConfig(catalyst());

      expect(await sw.executeCommand(`vlan ${id}`)).toMatch(REFUS);
    });

    it(`et \`vlan ${id}\` ne cree rien`, async () => {
      const sw = await enConfig(catalyst());
      await taper(sw, [`vlan ${id}`, 'end']);

      expect(await sw.executeCommand('show vlan brief'))
        .not.toMatch(new RegExp(`^${id}\\s`, 'm'));
    });
  }

  it('`vlan 4094` est accepte — c est la borne haute', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('vlan 4094')).not.toMatch(REFUS);
  });

  it('`vlan zorglub` est refuse', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('vlan zorglub')).toMatch(REFUS);
  });
});

describe('une PLAGE declare plusieurs VLAN d un coup', () => {
  it('`vlan 20-22` les cree tous les trois', async () => {
    const sw = await enConfig(catalyst());
    await taper(sw, ['vlan 20-22', 'exit', 'end']);
    const table = await sw.executeCommand('show vlan brief');

    for (const id of ['20', '21', '22']) {
      expect(table).toMatch(new RegExp(`^${id}\\s`, 'm'));
    }
  });
});

describe('`vlan ?` decrit sa place', () => {
  it('la plage annoncee est celle d IOS', async () => {
    const sw = await enConfig(catalyst());

    expect(await sw.executeCommand('vlan ?')).toMatch(/<1-4094>/);
  });
});

describe('un ROUTEUR n a pas cette commande', () => {
  it('`vlan 10` y est refuse en configuration globale', async () => {
    const r = new CiscoRouter('R', 0, 0) as unknown as Cli;
    (r as unknown as { powerOn(): void }).powerOn();
    await enConfig(r);

    expect(await r.executeCommand('vlan 10')).toMatch(REFUS);
  });
});
