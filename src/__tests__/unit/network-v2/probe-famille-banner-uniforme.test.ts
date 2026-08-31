/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * Ce qu'un `banner` d'IOS fait : quatre sortes (`motd`, `login`, `exec`,
 * `incoming`), un DELIMITEUR choisi par l'operateur — n'importe quel
 * caractere absent du texte —, une forme en ligne
 * (`banner motd #Bonjour#`) et une forme multiligne qui annonce
 * `Enter TEXT message.  End with the character '#'.` puis collecte
 * jusqu'a la ligne portant le delimiteur. La banniere se relit dans la
 * configuration sous la forme que l'operateur pourrait retaper, et
 * `no banner motd` la retire.
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

const SORTES = ['motd', 'login', 'exec', 'incoming'] as const;

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

describe('les quatre sortes de banniere existent des deux cotes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    for (const sorte of SORTES) {
      it(`${nom} — \`banner ${sorte}\` en ligne`, async () => {
        const d = await enConfig(faire());

        expect(await d.executeCommand(`banner ${sorte} #Bonjour#`))
          .not.toMatch(REFUS);
      });
    }
  }
});

describe('la forme EN LIGNE pose le texte entre les deux delimiteurs', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — le texte se relit dans la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('banner motd #Acces reserve#');

      expect(await config(d)).toContain('Acces reserve');
    });

    it(`${nom} — le delimiteur lui-meme n est pas garde`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('banner motd #Acces reserve#');
      const vue = await config(d);
      const ligne = vue.split('\n').find(l => l.includes('Acces reserve'));

      expect(ligne).toBeDefined();
      expect(ligne).not.toContain('#Acces');
    });

    it(`${nom} — le texte s arrete au PREMIER delimiteur`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('banner motd #Avant#Apres#');

      expect(await config(d)).not.toContain('Apres');
    });

    it(`${nom} — les blancs INTERIEURS sont gardes tels quels`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('banner motd #Deux  blancs#');

      expect(await config(d)).toContain('Deux  blancs');
    });

    it(`${nom} — un delimiteur quelconque fonctionne`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('banner motd ZTexte avec Z');

      expect(await config(d)).toContain('Texte avec ');
    });
  }
});

describe('la forme MULTILIGNE annonce, collecte, puis se termine', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l annonce est celle d IOS`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('banner motd #'))
        .toBe("Enter TEXT message.  End with the character '#'.");
    });

    it(`${nom} — les lignes saisies deviennent la banniere`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['banner motd #', 'Ligne une', 'Ligne deux', '#']);

      const vue = await config(d);
      expect(vue).toContain('Ligne une');
      expect(vue).toContain('Ligne deux');
    });

    it(`${nom} — la ligne du delimiteur ne fait pas partie du texte`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['banner motd #', 'Ligne une', '#']);
      const vue = await config(d);

      expect(vue.split('\n').filter(l => l.trim() === '#').length).toBeLessThan(2);
    });

    it(`${nom} — la collecte finie, on est de retour en configuration`, async () => {
      const d = await enConfig(faire());
      await taper(d, ['banner motd #', 'Ligne une', '#']);

      expect(await d.executeCommand('hostname APRES')).not.toMatch(REFUS);
    });

    it(`${nom} — `.concat('`^C` est un delimiteur, pas deux caracteres'), async () => {
      const d = await enConfig(faire());
      const annonce = await d.executeCommand('banner motd ^C');
      await taper(d, ['Interdit', '^C']);

      expect(annonce).toContain("End with the character '^C'.");
      expect(await config(d)).toContain('Interdit');
    });
  }
});

describe('`no banner <sorte>` retire la banniere', () => {
  for (const [nom, faire] of PLATEFORMES) {
    for (const sorte of SORTES) {
      it(`${nom} — \`no banner ${sorte}\``, async () => {
        const d = await enConfig(faire());
        await taper(d, [
          `banner ${sorte} #Efface moi#`, `no banner ${sorte}`,
        ]);

        expect(await config(d)).not.toContain('Efface moi');
      });
    }
  }
});

describe('une saisie fautive est REFUSEE', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — `.concat('`banner` seul est incomplet'), async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('banner')).toMatch(/Incomplete command/);
    });

    it(`${nom} — une sorte inconnue est refusee`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('banner zorglub #Texte#'))
        .toMatch(/Invalid input/);
    });

    it(`${nom} — et elle n entre pas dans la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('banner zorglub #Texte#');

      expect(await config(d)).not.toContain('zorglub');
    });
  }
});

describe('`banner ?` decrit ses sortes, pareil des deux cotes', () => {
  async function aide(d: Cli): Promise<string> {
    await enConfig(d);
    return d.executeCommand('banner ?');
  }

  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — les quatre sortes y figurent avec une description`, async () => {
      const vue = await aide(faire());

      for (const sorte of SORTES) {
        expect(vue).toMatch(new RegExp(`^\\s*${sorte}\\s+\\S`, 'm'));
      }
    });
  }

  it('les deux plateformes rendent la MEME aide', async () => {
    const [a, b] = await Promise.all(PLATEFORMES.map(([, faire]) => aide(faire())));

    expect(a).toBe(b);
  });
});
