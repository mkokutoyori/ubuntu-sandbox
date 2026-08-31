/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `ip route` est la commande de configuration la plus tapee de tout
 * IOS. Sa grammaire :
 *
 *     ip route <reseau> <masque> { <saut> | <interface> [<saut>] }
 *              [<distance>] [permanent] [name <texte>] [tag <n>]
 *
 * Quatre faits qu'un apprenant apprend ici et nulle part ailleurs. La
 * DISTANCE par defaut d'une statique est 1 ; une distance donnee en fait
 * une route de SECOURS, qui ne sert que si la principale s'en va ; deux
 * routes vers le meme prefixe par deux sauts differents sont DEUX
 * routes, pas une ; et `no ip route` retire celle qu'on lui NOMME, pas
 * une autre du meme prefixe.
 *
 * La configuration rendue doit reproduire ce qui a ete tape : elle est
 * rejouee a l'import d'une topologie, donc une distance perdue au rendu
 * est une route de secours qui redevient principale.
 *
 * La commande existe sur un routeur comme sur un Catalyst qui route :
 * chaque cas est joue des DEUX cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
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

const REFUS = /Invalid input|Incomplete command|Invalid network|Invalid mask|Invalid next-hop/;

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

let serie = 0;

async function routeur(): Promise<Cli> {
  const equipement = new CiscoRouter(`R${serie++}`, 0, 0);
  const voisin = new LinuxPC(`pc${serie}`, `PC${serie}`, 0, 0);
  new Cable(`c${serie}`).connect(equipement.getPorts()[0], voisin.getPorts()[0]);
  const r = equipement as unknown as Cli;
  (r as unknown as { powerOn(): void }).powerOn();
  await taper(r, [
    'enable', 'configure terminal', `interface ${r.getPortNames()[0]}`,
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  ]);
  return r;
}

async function catalyst(): Promise<Cli> {
  const equipement = new CiscoSwitch('switch-cisco', `SW${serie++}`, 8, 0, 0);
  const voisin = new LinuxPC(`pc${serie}`, `PC${serie}`, 0, 0);
  new Cable(`c${serie}`).connect(equipement.getPorts()[0], voisin.getPorts()[0]);
  const s = equipement as unknown as Cli;
  (s as unknown as { powerOn(): void }).powerOn();
  await taper(s, [
    'enable', 'configure terminal', 'ip routing', 'vlan 10', 'exit',
    `interface ${s.getPortNames()[0]}`,
    'switchport mode access', 'switchport access vlan 10', 'no shutdown', 'exit',
    'interface Vlan10', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  ]);
  return s;
}

const PLATEFORMES: ReadonlyArray<[string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

const config = async (d: Cli): Promise<string> => {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
};

const table = async (d: Cli): Promise<string> => {
  await d.executeCommand('end');
  return d.executeCommand('show ip route');
};

describe('une route statique est acceptee et PARAIT', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — elle entre dans la table`, async () => {
      const d = await faire();
      await d.executeCommand('ip route 192.168.9.0 255.255.255.0 10.0.0.2');

      expect(await table(d)).toMatch(/^S\s+192\.168\.9\.0\/24 \[1\/0\] via 10\.0\.0\.2/m);
    });

    it(`${nom} — et la configuration la rend telle qu on l a tapee`, async () => {
      const d = await faire();
      await d.executeCommand('ip route 192.168.9.0 255.255.255.0 10.0.0.2');

      expect(await config(d))
        .toMatch(/^ip route 192\.168\.9\.0 255\.255\.255\.0 10\.0\.0\.2$/m);
    });
  }
});

describe('la DISTANCE fait la route de secours', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la table la rend`, async () => {
      const d = await faire();
      await d.executeCommand('ip route 192.168.9.0 255.255.255.0 10.0.0.2 200');

      expect(await table(d)).toMatch(/^S\s+192\.168\.9\.0\/24 \[200\/0\] via/m);
    });

    it(`${nom} — la configuration la garde`, async () => {
      const d = await faire();
      await d.executeCommand('ip route 192.168.9.0 255.255.255.0 10.0.0.2 200');

      expect(await config(d))
        .toMatch(/^ip route 192\.168\.9\.0 255\.255\.255\.0 10\.0\.0\.2 200$/m);
    });

    it(`${nom} — la principale l emporte sur le secours`, async () => {
      const d = await faire();
      await taper(d, [
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2 200',
        'ip route 192.168.9.0 255.255.255.0 10.0.0.3',
      ]);
      const vue = await table(d);

      expect(vue).toMatch(/^S\s+192\.168\.9\.0\/24 \[1\/0\] via 10\.0\.0\.3/m);
      expect(vue).not.toMatch(/\[200\/0\]/);
    });
  }
});

describe('deux sauts vers un meme prefixe sont DEUX routes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la configuration rend les deux`, async () => {
      const d = await faire();
      await taper(d, [
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2',
        'ip route 192.168.9.0 255.255.255.0 10.0.0.3',
      ]);
      const lignes = (await config(d)).split('\n')
        .filter(l => l.startsWith('ip route 192.168.9.0'));

      expect(lignes).toHaveLength(2);
    });

    it(`${nom} — poser deux fois la MEME route n en fait qu une`, async () => {
      const d = await faire();
      await taper(d, [
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2',
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2',
      ]);
      const lignes = (await config(d)).split('\n')
        .filter(l => l.startsWith('ip route 192.168.9.0'));

      expect(lignes).toHaveLength(1);
    });
  }
});

describe('`no ip route` retire celle qu on NOMME', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la route nommee s en va`, async () => {
      const d = await faire();
      await taper(d, [
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2',
        'no ip route 192.168.9.0 255.255.255.0 10.0.0.2',
      ]);

      expect(await config(d)).not.toContain('ip route 192.168.9.0');
    });

    it(`${nom} — et l AUTRE route du meme prefixe reste`, async () => {
      const d = await faire();
      await taper(d, [
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2',
        'ip route 192.168.9.0 255.255.255.0 10.0.0.3',
        'no ip route 192.168.9.0 255.255.255.0 10.0.0.2',
      ]);
      const vue = await config(d);

      expect(vue).toContain('ip route 192.168.9.0 255.255.255.0 10.0.0.3');
      expect(vue).not.toContain('ip route 192.168.9.0 255.255.255.0 10.0.0.2');
    });
  }
});

describe('la route par DEFAUT', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — elle parait dans la configuration`, async () => {
      const d = await faire();
      await d.executeCommand('ip route 0.0.0.0 0.0.0.0 10.0.0.2');

      expect(await config(d)).toMatch(/^ip route 0\.0\.0\.0 0\.0\.0\.0 10\.0\.0\.2$/m);
    });

    it(`${nom} — et la table l annonce comme passerelle de dernier recours`, async () => {
      const d = await faire();
      await d.executeCommand('ip route 0.0.0.0 0.0.0.0 10.0.0.2');

      expect(await table(d))
        .toContain('Gateway of last resort is 10.0.0.2 to network 0.0.0.0');
    });
  }
});

describe('une saisie malformee est REFUSEE', () => {
  const FAUTIVES: ReadonlyArray<[string, string]> = [
    ['un reseau qui n en est pas un', 'ip route zorglub 255.255.255.0 10.0.0.2'],
    ['un masque qui n en est pas un', 'ip route 192.168.9.0 zorglub 10.0.0.2'],
    ['un saut qui n en est pas un', 'ip route 192.168.9.0 255.255.255.0 zorglub'],
  ];

  for (const [nom, faire] of PLATEFORMES) {
    for (const [quoi, saisie] of FAUTIVES) {
      it(`${nom} — ${quoi}`, async () => {
        const d = await faire();

        expect(await d.executeCommand(saisie)).toMatch(REFUS);
      });
    }

    it(`${nom} — et rien de fautif n entre dans la configuration`, async () => {
      const d = await faire();
      for (const [, saisie] of FAUTIVES) await d.executeCommand(saisie);

      expect(await config(d)).not.toContain('zorglub');
    });

    it(`${nom} — sans saut suivant, la commande est incomplete`, async () => {
      const d = await faire();

      expect(await d.executeCommand('ip route 192.168.9.0 255.255.255.0'))
        .toMatch(/Incomplete command/);
    });
  }
});
