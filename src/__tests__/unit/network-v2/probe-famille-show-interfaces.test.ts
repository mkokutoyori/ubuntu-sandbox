/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `show interfaces` decrit la COUCHE 2 — c'est le pendant exact de
 * `show ip interface`, qui decrit la couche 3, et les confondre est un
 * defaut que ce depot a deja ferme une fois. Chaque interface y ouvre un
 * bloc, dont la premiere ligne porte les DEUX etats qu'un operateur lit
 * en premier :
 *
 *     GigabitEthernet0/0 is up, line protocol is up
 *       Hardware is Gigabit Ethernet, address is 0011.2233.4455 (bia 0011.2233.4455)
 *       Internet address is 10.0.0.1/24
 *       MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,
 *          reliability 255/255, txload 1/255, rxload 1/255
 *       Encapsulation ARPA, loopback not set
 *       ...
 *          0 packets input, 0 bytes, 0 no buffer
 *          0 packets output, 0 bytes, 0 underruns
 *
 * Ce que la premiere ligne dit et que rien d'autre ne dit : l'etat
 * ADMINISTRATIF et l'etat du PROTOCOLE sont deux faits distincts.
 * `shutdown` donne `administratively down, line protocol is down` — la
 * formule exacte, qu'un apprenant apprend a reconnaitre —, un cable
 * absent donne `down, line protocol is down`, et les deux se
 * diagnostiquent differemment.
 *
 * `show interfaces <nom>` restreint a une interface,
 * `show interfaces description` rend le tableau des descriptions.
 *
 * La commande existe sur un routeur comme sur un Catalyst : chaque cas
 * est joue des DEUX cotes. Le port du routeur est CABLE — la lecon du
 * lot precedent : sans lien qui monte, un laboratoire mal bati et un
 * defaut sont indiscernables.
 *
 * RESULTAT DE LA MESURE, ecrit ici plutot que tu : les vingt-huit cas
 * passent des DEUX cotes avant comme apres le lot qui a migre cette
 * famille au socle. Cette sonde ne trouve donc aucun defaut — elle
 * GARDE que le deplacement n'en introduit pas, ce qui est sa raison
 * d'etre.
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

const REFUS = /Invalid input|Incomplete command|Unknown command/;

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

let serie = 0;

async function routeur(): Promise<{ cli: Cli; port: string }> {
  const equipement = new CiscoRouter(`R${serie++}`, 0, 0);
  const voisin = new LinuxPC(`pc${serie}`, `PC${serie}`, 0, 0);
  new Cable(`c${serie}`).connect(equipement.getPorts()[0], voisin.getPorts()[0]);
  const r = equipement as unknown as Cli;
  (r as unknown as { powerOn(): void }).powerOn();
  const port = r.getPortNames()[0];
  await taper(r, [
    'enable', 'configure terminal', `interface ${port}`,
    'ip address 10.0.0.1 255.255.255.0', 'description LIEN-COEUR',
    'no shutdown', 'exit', 'end',
  ]);
  return { cli: r, port };
}

async function catalyst(): Promise<{ cli: Cli; port: string }> {
  const equipement = new CiscoSwitch('switch-cisco', `SW${serie++}`, 8, 0, 0);
  const voisin = new LinuxPC(`pc${serie}`, `PC${serie}`, 0, 0);
  new Cable(`c${serie}`).connect(equipement.getPorts()[0], voisin.getPorts()[0]);
  const s = equipement as unknown as Cli;
  (s as unknown as { powerOn(): void }).powerOn();
  const port = s.getPortNames()[0];
  await taper(s, [
    'enable', 'configure terminal', `interface ${port}`,
    'description LIEN-COEUR', 'no shutdown', 'exit', 'end',
  ]);
  return { cli: s, port };
}

const PLATEFORMES: ReadonlyArray<[string, () => Promise<{ cli: Cli; port: string }>]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

describe('la premiere ligne porte les DEUX etats', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — un port cable et ouvert est up/up`, async () => {
      const { cli, port } = await faire();

      expect(await cli.executeCommand(`show interfaces ${port}`))
        .toMatch(new RegExp(`^${port} is up, line protocol is up`, 'm'));
    });

    it(`${nom} — \`shutdown\` donne la formule d IOS`, async () => {
      const { cli, port } = await faire();
      await taper(cli, ['configure terminal', `interface ${port}`, 'shutdown', 'end']);

      expect(await cli.executeCommand(`show interfaces ${port}`))
        .toMatch(new RegExp(
          `^${port} is administratively down, line protocol is down`, 'm'));
    });

    it(`${nom} — un port SANS cable est down/down, pas administratively`, async () => {
      const { cli } = await faire();
      const orphelin = cli.getPortNames()[1];
      await taper(cli, ['configure terminal', `interface ${orphelin}`, 'no shutdown', 'end']);
      const vue = await cli.executeCommand(`show interfaces ${orphelin}`);

      expect(vue).toMatch(new RegExp(`^${orphelin} is down, line protocol is down`, 'm'));
      expect(vue).not.toContain('administratively down');
    });
  }
});

describe('le bloc decrit le MATERIEL et la couche 2', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l adresse materielle est rendue, avec sa \`bia\``, async () => {
      const { cli, port } = await faire();

      expect(await cli.executeCommand(`show interfaces ${port}`))
        .toMatch(/Hardware is .+, address is [0-9a-f.]+ \(bia [0-9a-f.]+\)/);
    });

    it(`${nom} — le MTU, la bande passante et le delai`, async () => {
      const { cli, port } = await faire();

      expect(await cli.executeCommand(`show interfaces ${port}`))
        .toMatch(/MTU \d+ bytes, BW \d+ Kbit\/sec, DLY \d+ usec/);
    });

    it(`${nom} — l encapsulation`, async () => {
      const { cli, port } = await faire();

      expect(await cli.executeCommand(`show interfaces ${port}`))
        .toMatch(/Encapsulation ARPA/);
    });

    it(`${nom} — la description tapee y figure`, async () => {
      const { cli, port } = await faire();

      expect(await cli.executeCommand(`show interfaces ${port}`))
        .toContain('LIEN-COEUR');
    });

    it(`${nom} — les compteurs de paquets`, async () => {
      const { cli, port } = await faire();
      const vue = await cli.executeCommand(`show interfaces ${port}`);

      expect(vue).toMatch(/\d+ packets input, \d+ bytes/);
      expect(vue).toMatch(/\d+ packets output, \d+ bytes/);
    });
  }
});

describe('`show interfaces <nom>` ne rend QUE cette interface', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — une seule interface y ouvre un bloc`, async () => {
      const { cli, port } = await faire();
      const vue = await cli.executeCommand(`show interfaces ${port}`);
      const blocs = vue.split('\n').filter(l => / is (up|down|administratively down),/.test(l));

      expect(blocs).toHaveLength(1);
    });

    it(`${nom} — une interface INCONNUE est signalee`, async () => {
      const { cli } = await faire();

      expect(await cli.executeCommand('show interfaces Zorglub0/9'))
        .toMatch(/Invalid input|not exist|Invalid interface/);
    });
  }
});

describe('`show interfaces` sans nom rend TOUTES les interfaces', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — chaque port y ouvre son bloc`, async () => {
      const { cli } = await faire();
      const vue = await cli.executeCommand('show interfaces');
      const blocs = vue.split('\n').filter(l => / is (up|down|administratively down),/.test(l));

      expect(blocs.length).toBe(cli.getPortNames().length);
    });
  }
});

describe('`show interfaces description` rend le tableau', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l en-tete porte les quatre intitules`, async () => {
      const { cli } = await faire();
      const entete = (await cli.executeCommand('show interfaces description'))
        .split('\n')[0];

      for (const mot of ['Interface', 'Status', 'Protocol', 'Description']) {
        expect(entete).toContain(mot);
      }
    });

    it(`${nom} — la description tapee y figure`, async () => {
      const { cli } = await faire();

      expect(await cli.executeCommand('show interfaces description'))
        .toContain('LIEN-COEUR');
    });
  }
});

describe('la vue est joignable depuis l EXEC UTILISATEUR', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — sans \`enable\``, async () => {
      const { cli } = await faire();
      await cli.executeCommand('disable');

      expect(await cli.executeCommand('show interfaces')).not.toMatch(REFUS);
    });
  }
});
