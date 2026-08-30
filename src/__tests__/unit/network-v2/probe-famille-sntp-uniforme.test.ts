/**
 * Ecrit A L'AVEUGLE depuis la reference du constructeur, avant toute
 * lecture du code : `sntp server`, `sntp broadcast client` et
 * `sntp logging` sont les trois formes que la Basic System Management
 * Command Reference decrit, et `show sntp` rend un tableau a quatre
 * colonnes dont la ligne synchronisee porte `Synced`.
 *
 * Ce que la premiere execution a trouve : `sntp broadcast client` et
 * `sntp logging` etaient REFUSEES sur les deux plateformes, et
 * `show sntp` rendait `1 / 4 / 00:00:01` en dur pour tout serveur —
 * trois constantes a la place de trois mesures.
 *
 * UNE premisse de cette sonde etait fausse et elle est corrigee ici
 * plutot qu'effacee : `sntp server 999.1.1.1` n'est pas refuse au caret,
 * parce que la commande accepte AUSSI un nom d'hote — la machine part
 * donc en resolution et repond `% Bad IP address or host name`, ce que
 * fait une vraie machine. Le cas suivant, qui verifie que rien n'entre
 * dans la configuration, est celui qui porte la garantie.
 *
 * Discrimination : 16 cas tombent avant correctif.
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
  getPortNames(): string[];
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

async function enConfig(d: Cli): Promise<Cli> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

const FORMES: ReadonlyArray<[string, string]> = [
  ['sntp server 10.0.0.5', 'sntp server 10.0.0.5'],
  ['sntp broadcast client', 'sntp broadcast client'],
  ['sntp logging', 'sntp logging'],
];

describe('les formes de `sntp` sont acceptees des deux cotes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    for (const [saisie] of FORMES) {
      it(`${nom} — \`${saisie}\``, async () => {
        const d = await enConfig(faire());

        expect(await d.executeCommand(saisie)).not.toMatch(REFUS);
      });
    }
  }
});

describe('ce qui est tape se relit dans la configuration', () => {
  for (const [nom, faire] of PLATEFORMES) {
    for (const [saisie, rendu] of FORMES) {
      it(`${nom} — \`${saisie}\``, async () => {
        const d = await enConfig(faire());
        await d.executeCommand(saisie);

        expect(await config(d)).toContain(rendu);
      });
    }
  }
});

describe('le `no` retire ce que la commande avait pose', () => {
  for (const [nom, faire] of PLATEFORMES) {
    for (const [saisie, rendu] of FORMES) {
      it(`${nom} — \`no ${saisie}\``, async () => {
        const d = await enConfig(faire());
        await taper(d, [saisie, `no ${saisie}`]);

        expect(await config(d)).not.toContain(rendu);
      });
    }
  }
});

describe('`show sntp` rend le tableau du constructeur', () => {
  const ENTETE = /SNTP server\s+Stratum\s+Version\s+Last Receive/;

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l en-tete porte les quatre colonnes`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['sntp server 10.0.0.5', 'end']);

      expect(await d.executeCommand('show sntp')).toMatch(ENTETE);
    });

    it(`${nom} — le serveur configure y figure`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['sntp server 10.0.0.5', 'end']);

      expect(await d.executeCommand('show sntp')).toContain('10.0.0.5');
    });

    it(`${nom} — deux serveurs donnent deux lignes`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['sntp server 10.0.0.5', 'sntp server 10.0.0.10', 'end']);
      const lignes = (await d.executeCommand('show sntp'))
        .split('\n').filter(l => /^\s*\d+\.\d+\.\d+\.\d+/.test(l));

      expect(lignes.length).toBe(2);
    });
  }
});

describe('une saisie fautive est REFUSEE, pas rangee', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`sntp server\` sans adresse est incomplete`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('sntp server')).toMatch(/Incomplete command/);
    });

    it(`${nom} — \`sntp zorglub\` est refuse`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('sntp zorglub')).toMatch(/Invalid input/);
    });

    it(`${nom} — une adresse malformee part en RESOLUTION, puis echoue`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('sntp server 999.1.1.1'))
        .toMatch(/% Bad IP address or host name/);
    });

    it(`${nom} — et elle n entre pas dans la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('sntp server 999.1.1.1');

      expect(await config(d)).not.toContain('999.1.1.1');
    });

    it(`${nom} — `.concat('`sntp` est une commande de CONFIGURATION'), async () => {
      const d = faire();
      await d.executeCommand('enable');
      const refus = await d.executeCommand('sntp server 10.0.0.5');

      expect(refus).toMatch(/Translating "sntp"/);
      expect(await d.executeCommand('show sntp')).toBe('No SNTP servers configured');
    });
  }
});

describe('`sntp logging` et `ntp logging` posent le MEME fait', () => {
  async function journalise(d: Cli, saisie: string): Promise<string> {
    await enConfig(d);
    await d.executeCommand(saisie);
    return config(d);
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — `.concat('`ntp logging` garde son orthographe'), async () => {
      expect(await journalise(faire(), 'ntp logging')).toContain('ntp logging');
    });

    it(`${nom} — `.concat('`sntp logging` garde la sienne'), async () => {
      const vue = await journalise(faire(), 'sntp logging');

      expect(vue).toContain('sntp logging');
      expect(vue).not.toMatch(/^ntp logging$/m);
    });

    it(`${nom} — l une DEFAIT l autre, un seul drapeau`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['sntp logging', 'no ntp logging']);

      expect(await config(d)).not.toMatch(/logging$/m);
    });
  }
});

describe('`sntp ?` decrit ses sous-commandes, pareil des deux cotes', () => {
  async function aide(d: Cli): Promise<string> {
    await enConfig(d);
    return d.executeCommand('sntp ?');
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — `.concat('`broadcast`, `logging` et `server` y sont'), async () => {
      const vue = await aide(faire());

      expect(vue).toMatch(/^\s*broadcast\s+\S/m);
      expect(vue).toMatch(/^\s*logging\s+\S/m);
      expect(vue).toMatch(/^\s*server\s+\S/m);
    });

    it(`${nom} — chaque mot-cle porte une description`, async () => {
      const vue = await aide(faire());
      const lignes = vue.split('\n').filter(l => /^\s{2,}\S/.test(l));

      expect(lignes.length).toBeGreaterThan(0);
      expect(lignes.every(l => l.trim().split(/\s{2,}/).length >= 2)).toBe(true);
    });
  }

  it('les deux plateformes rendent la MEME aide', async () => {
    const [a, b] = await Promise.all(PLATEFORMES.map(([, faire]) => aide(faire())));

    expect(a).toBe(b);
  });
});
