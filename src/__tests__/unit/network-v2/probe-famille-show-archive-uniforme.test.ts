/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * Ce que la famille `show archive` promet : `show archive` nomme le
 * PROCHAIN fichier et enumere les revisions deja ecrites ;
 * `show archive log config all` rend le journal de configuration —
 * index, session, utilisateur et commande — que `log config` alimente ;
 * `show archive config differences` compare deux etats et rend un diff
 * contextuel. Les trois existent sur un routeur comme sur un Catalyst,
 * qui connait l'archivage.
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

async function archivant(faire: () => Cli): Promise<Cli> {
  const d = faire();
  await taper(d, [
    'enable', 'configure terminal',
    'archive', 'path flash:cfg', 'maximum 5', 'log config', 'end',
  ]);
  return d;
}

describe('les trois vues existent des deux cotes', () => {
  const VUES = [
    'show archive',
    'show archive log config all',
    'show archive config differences',
  ];

  for (const [nom, faire] of PLATEFORMES) {
    for (const vue of VUES) {
      it(`${nom} — \`${vue}\``, async () => {
        const d = await archivant(faire);

        expect(await d.executeCommand(vue)).not.toMatch(REFUS);
      });
    }
  }
});

describe('`show archive` decrit un archivage REEL', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — sans archivage configure, elle le dit`, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('show archive'))
        .toMatch(/No archives configured/);
    });

    it(`${nom} — elle nomme le PROCHAIN fichier`, async () => {
      const d = await archivant(faire);

      expect(await d.executeCommand('show archive'))
        .toMatch(/next archive file will be named flash:cfg/);
    });

    it(`${nom} — une revision ecrite y figure`, async () => {
      const d = await archivant(faire);
      await d.executeCommand('archive config');

      expect(await d.executeCommand('show archive')).toMatch(/flash:cfg-1/);
    });

    it(`${nom} — la derniere revision est MARQUEE`, async () => {
      const d = await archivant(faire);
      await taper(d, ['archive config', 'archive config']);

      expect(await d.executeCommand('show archive')).toMatch(/Most Recent/);
    });

    it(`${nom} — le fichier archive existe pour de bon dans flash:`, async () => {
      const d = await archivant(faire);
      await d.executeCommand('archive config');

      expect(await d.executeCommand('dir flash:')).toMatch(/cfg-1/);
    });
  }
});

describe('`show archive log config` rend QUI a tape QUOI', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la commande tapee y figure`, async () => {
      const d = await archivant(faire);
      await taper(d, ['configure terminal', 'hostname JOURNALISE', 'end']);

      expect(await d.executeCommand('show archive log config all'))
        .toMatch(/hostname JOURNALISE/);
    });

    it(`${nom} — l utilisateur ou la ligne y figure`, async () => {
      const d = await archivant(faire);
      await taper(d, ['configure terminal', 'hostname JOURNALISE', 'end']);
      const vue = await d.executeCommand('show archive log config all');

      expect(vue).toMatch(/console/);
    });

    it(`${nom} — une commande REFUSEE n y entre pas`, async () => {
      const d = await archivant(faire);
      await taper(d, ['configure terminal', 'zorglub inexistant', 'end']);

      expect(await d.executeCommand('show archive log config all'))
        .not.toMatch(/zorglub/);
    });
  }
});

describe('`show archive config differences` compare deux etats', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — un changement parait avec son signe`, async () => {
      const d = await archivant(faire);
      await d.executeCommand('archive config');
      await taper(d, ['configure terminal', 'hostname CHANGEE', 'end']);
      const vue = await d.executeCommand('show archive config differences');

      expect(vue).toMatch(/^[+-].*CHANGEE/m);
    });

    it(`${nom} — sans changement, aucun signe n est rendu`, async () => {
      const d = await archivant(faire);
      await d.executeCommand('archive config');
      const vue = await d.executeCommand('show archive config differences');

      expect(vue).not.toMatch(/^[+-]\s*\S/m);
    });
  }
});

describe('`show archive ?` decrit ses suites, pareil des deux cotes', () => {
  async function aide(d: Cli): Promise<string> {
    await d.executeCommand('enable');
    return d.executeCommand('show archive ?');
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — `.concat('`config` et `log` y sont decrits'), async () => {
      const vue = await aide(faire());

      expect(vue).toMatch(/^\s*config\s+\S/m);
      expect(vue).toMatch(/^\s*log\s+\S/m);
    });
  }

  it('les deux plateformes rendent la MEME aide', async () => {
    const [a, b] = await Promise.all(PLATEFORMES.map(([, faire]) => aide(faire())));

    expect(a).toBe(b);
  });
});
