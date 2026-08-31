/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `enable [<niveau>]` ouvre l'EXEC privilegie, ou le niveau demande ;
 * sans argument c'est le niveau 15. Elle se tape depuis l'EXEC
 * utilisateur COMME depuis l'EXEC privilegie — c'est ainsi qu'on
 * DESCEND d'un niveau, `enable 5` depuis `#` ramenant a 5 — et
 * `show privilege` rend le niveau courant. L'invite porte `#` au niveau
 * 15 et `>` en dessous. `disable` redescend. Un niveau hors de 0-15 est
 * refuse.
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

function routeur(): Cli {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return r as unknown as Cli;
}

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

const PLATEFORMES: ReadonlyArray<[string, () => Cli]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

describe('`enable` sans argument monte au niveau 15', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l invite passe a #`, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(d.getPrompt()).toMatch(/#$/);
    });

    it(`${nom} — `.concat('`show privilege` annonce 15'), async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('show privilege'))
        .toContain('Current privilege level is 15');
    });
  }
});

describe('`enable <niveau>` ouvre le niveau demande', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — depuis l EXEC utilisateur`, async () => {
      const d = faire();
      await d.executeCommand('enable 7');

      expect(await d.executeCommand('show privilege'))
        .toContain('Current privilege level is 7');
    });

    it(`${nom} — l invite reste > en dessous de 15`, async () => {
      const d = faire();
      await d.executeCommand('enable 7');

      expect(d.getPrompt()).toMatch(/>$/);
    });

    it(`${nom} — depuis l EXEC PRIVILEGIE, elle fait DESCENDRE`, async () => {
      const d = faire();
      await taper(d, ['enable', 'enable 7']);

      expect(await d.executeCommand('show privilege'))
        .toContain('Current privilege level is 7');
    });

    it(`${nom} — et l invite suit la descente`, async () => {
      const d = faire();
      await taper(d, ['enable', 'enable 7']);

      expect(d.getPrompt()).toMatch(/>$/);
    });
  }
});

describe('`disable` redescend', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — le niveau retombe a 1`, async () => {
      const d = faire();
      await taper(d, ['enable', 'disable']);

      expect(await d.executeCommand('show privilege'))
        .toContain('Current privilege level is 1');
    });

    it(`${nom} — et l invite redevient >`, async () => {
      const d = faire();
      await taper(d, ['enable', 'disable']);

      expect(d.getPrompt()).toMatch(/>$/);
    });
  }
});

describe('un niveau invalide est REFUSE', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`enable 16\``, async () => {
      const d = faire();

      expect(await d.executeCommand('enable 16')).toMatch(/Invalid input/);
    });

    it(`${nom} — \`enable zorglub\``, async () => {
      const d = faire();

      expect(await d.executeCommand('enable zorglub')).toMatch(/Invalid input/);
    });

    it(`${nom} — et le niveau ne bouge pas`, async () => {
      const d = faire();
      await d.executeCommand('enable 16');

      expect(d.getPrompt()).toMatch(/>$/);
    });
  }
});

describe('`enable ?` decrit sa place, pareil des deux cotes', () => {
  async function aide(d: Cli, amont: readonly string[]): Promise<string> {
    await taper(d, amont);
    return d.executeCommand('enable ?');
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la place du niveau est annoncee`, async () => {
      const vue = await aide(faire(), []);

      expect(vue).toMatch(/<0-15>/);
    });

    it(`${nom} — l aide est la MEME depuis les deux EXEC`, async () => {
      const utilisateur = await aide(faire(), []);
      const privilegie = await aide(faire(), ['enable']);

      expect(privilegie).toBe(utilisateur);
    });
  }
});
