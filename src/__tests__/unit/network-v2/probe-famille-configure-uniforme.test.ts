/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `configure terminal` entre en configuration globale depuis l'EXEC
 * privilegie, s'abrege (`conf t`), et une vraie machine l'accepte encore
 * une fois qu'on y est. `configure replace <url>` remplace la
 * configuration courante par un fichier. Un mot inconnu apres
 * `configure` est refuse, et la commande est hors de portee de l'EXEC
 * utilisateur.
 *
 * UNE premisse etait fausse et elle est corrigee ici plutot
 * qu'effacee : `configure terminal` ne rend PAS la chaine vide — un
 * vrai IOS annonce `Enter configuration commands, one per line.  End
 * with CNTL/Z.`, ce que le simulateur faisait deja.
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

const REFUS = /Invalid input|Incomplete command|Unknown command/;

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

describe('`configure terminal` ouvre la configuration globale', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l invite passe en (config)`, async () => {
      const d = faire();
      await taper(d, ['enable', 'configure terminal']);

      expect(d.getPrompt()).toMatch(/\(config\)#$/);
    });

    it(`${nom} — elle annonce ce qu IOS annonce`, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('configure terminal'))
        .toContain('Enter configuration commands, one per line.  End with CNTL/Z.');
    });

    it(`${nom} — l abreviation \`conf t\` fait la meme chose`, async () => {
      const d = faire();
      await taper(d, ['enable', 'conf t']);

      expect(d.getPrompt()).toMatch(/\(config\)#$/);
    });

    it(`${nom} — une fois en configuration, elle est encore acceptee`, async () => {
      const d = faire();
      await taper(d, ['enable', 'configure terminal']);

      expect(await d.executeCommand('configure terminal')).not.toMatch(REFUS);
      expect(d.getPrompt()).toMatch(/\(config\)#$/);
    });

    it(`${nom} — `.concat('`end` en sort'), async () => {
      const d = faire();
      await taper(d, ['enable', 'configure terminal', 'end']);

      expect(d.getPrompt()).toMatch(/[^)]#$/);
    });
  }
});

describe('`configure` est reservee a l EXEC privilegie', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — depuis l EXEC utilisateur, elle est refusee`, async () => {
      const d = faire();

      expect(await d.executeCommand('configure terminal')).toMatch(REFUS);
    });

    it(`${nom} — et l invite ne change pas`, async () => {
      const d = faire();
      await d.executeCommand('configure terminal');

      expect(d.getPrompt()).toMatch(/>$/);
    });
  }
});

describe('une suite inconnue de `configure` est refusee', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`configure zorglub\``, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('configure zorglub')).toMatch(/Invalid input/);
    });

    it(`${nom} — et l invite reste en EXEC privilegie`, async () => {
      const d = faire();
      await taper(d, ['enable', 'configure zorglub']);

      expect(d.getPrompt()).not.toMatch(/\(config\)/);
    });
  }
});

describe('`configure replace` remplace la configuration courante', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — un fichier ABSENT est signale`, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('configure replace flash:absent.cfg'))
        .toMatch(/Error opening|No such file/);
    });

    it(`${nom} — une archive ecrite se rejoue`, async () => {
      const d = faire();
      await taper(d, [
        'enable', 'configure terminal', 'archive', 'path flash:cfg', 'end',
        'archive config',
        'configure terminal', 'hostname APRES-ARCHIVE', 'end',
      ]);
      await d.executeCommand('configure replace flash:cfg-1');

      expect(d.getPrompt()).not.toMatch(/APRES-ARCHIVE/);
    });
  }
});

describe('`configure ?` decrit ses suites, pareil des deux cotes', () => {
  async function aide(d: Cli): Promise<string> {
    await d.executeCommand('enable');
    return d.executeCommand('configure ?');
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — `.concat('`terminal` et `replace` y sont decrits'), async () => {
      const vue = await aide(faire());

      expect(vue).toMatch(/^\s*terminal\s+\S/m);
      expect(vue).toMatch(/^\s*replace\s+\S/m);
    });
  }

  it('les deux plateformes rendent la MEME aide', async () => {
    const [a, b] = await Promise.all(PLATEFORMES.map(([, faire]) => aide(faire())));

    expect(a).toBe(b);
  });
});
