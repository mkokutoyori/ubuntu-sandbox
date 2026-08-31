/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `show ip route` est la vue la plus tapee de tout IOS apres la
 * configuration. Elle rend, dans cet ordre : la LEGENDE des codes, la
 * passerelle de dernier recours, puis les routes groupees par reseau
 * majeur.
 *
 *     Codes: L - local, C - connected, S - static, R - RIP, ...
 *
 *     Gateway of last resort is not set
 *
 *           10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks
 *     C        10.0.0.0/24 is directly connected, GigabitEthernet0/0
 *     L        10.0.0.1/32 is directly connected, GigabitEthernet0/0
 *     S*    0.0.0.0/0 [1/0] via 10.0.0.2
 *
 * Trois faits qu'un apprenant lit sur cette sortie et nulle part
 * ailleurs. Une interface adressee produit DEUX routes depuis IOS 15 —
 * la connectee `C` et la locale `L` en /32 —, une route statique porte
 * sa distance et sa metrique entre crochets, et l'etoile marque la
 * candidate par defaut, la passerelle de dernier recours etant annoncee
 * en tete.
 *
 * `show ip route <protocole>` filtre : `connected`, `static`, `ospf`,
 * `rip`, `eigrp`, `bgp`. `show ip route <prefixe>` rend le detail d'une
 * seule route, avec le bloc `Routing Descriptor Blocks:` qui dit par ou
 * le paquet sort — c'est l'objet meme de cette forme.
 *
 * La commande existe sur un routeur comme sur un Catalyst des lors qu'il
 * route (`ip routing` + un SVI adresse) : chaque cas est joue des DEUX
 * cotes.
 *
 * PREMISSE CORRIGEE PAR LA MESURE. La premiere version de ce laboratoire
 * adressait le port du routeur sans le CABLER, et sa table etait vide :
 * une route connectee suppose un lien qui monte, et une statique dont le
 * saut suivant tombe derriere ce lien s'en va avec lui — c'est
 * exactement ce que le depot appelle `isRouteUsable`, donc un
 * comportement JUSTE. Sans le cable, un laboratoire mal bati et un
 * defaut auraient ete indiscernables. Le port est desormais cable a une
 * machine tierce, ce que fait un operateur.
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

/**
 * Une machine qui ROUTE, sur chaque plateforme.
 *
 * Un Catalyst ne route qu'apres `ip routing`, et il porte ses adresses
 * sur un SVI ; un port physique de commutation refuse `ip address`.
 */
let serie = 0;

async function routeur(): Promise<{ cli: Cli; iface: string }> {
  const equipement = new CiscoRouter(`R${serie++}`, 0, 0);
  const voisin = new LinuxPC(`pc${serie}`, `PC${serie}`, 0, 0);
  new Cable(`c${serie}`).connect(equipement.getPorts()[0], voisin.getPorts()[0]);
  const r = equipement as unknown as Cli;
  (r as unknown as { powerOn(): void }).powerOn();
  const port = r.getPortNames()[0];
  await taper(r, [
    'enable', 'configure terminal', `interface ${port}`,
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end',
  ]);
  return { cli: r, iface: port };
}

async function catalyst(): Promise<{ cli: Cli; iface: string }> {
  const equipement = new CiscoSwitch('switch-cisco', `SW${serie++}`, 8, 0, 0);
  const voisin = new LinuxPC(`pc${serie}`, `PC${serie}`, 0, 0);
  new Cable(`c${serie}`).connect(equipement.getPorts()[0], voisin.getPorts()[0]);
  const s = equipement as unknown as Cli;
  (s as unknown as { powerOn(): void }).powerOn();
  await taper(s, [
    'enable', 'configure terminal', 'ip routing',
    'vlan 10', 'exit',
    `interface ${s.getPortNames()[0]}`,
    'switchport mode access', 'switchport access vlan 10', 'no shutdown', 'exit',
    'interface Vlan10',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end',
  ]);
  return { cli: s, iface: 'Vlan10' };
}

const PLATEFORMES: ReadonlyArray<[string, () => Promise<{ cli: Cli; iface: string }>]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

async function avecStatique(
  faire: () => Promise<{ cli: Cli; iface: string }>,
): Promise<{ cli: Cli; iface: string }> {
  const lab = await faire();
  await taper(lab.cli, [
    'configure terminal',
    'ip route 192.168.9.0 255.255.255.0 10.0.0.2',
    'end',
  ]);
  return lab;
}

describe('`show ip route` rend la legende des codes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la legende commence par \`Codes:\``, async () => {
      const { cli } = await faire();

      expect(await cli.executeCommand('show ip route')).toMatch(/^Codes:/m);
    });

    it(`${nom} — les codes des routes RENDUES y sont decrits`, async () => {
      const { cli } = await avecStatique(faire);
      const vue = await cli.executeCommand('show ip route');
      const legende = vue.slice(0, vue.indexOf('Gateway of last resort'));

      expect(legende).toMatch(/C - connected/);
      expect(legende).toMatch(/S - static/);
      expect(legende).toMatch(/L - local/);
    });
  }
});

describe('la passerelle de dernier recours est annoncee', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — sans route par defaut, elle n est pas posee`, async () => {
      const { cli } = await faire();

      expect(await cli.executeCommand('show ip route'))
        .toContain('Gateway of last resort is not set');
    });

    it(`${nom} — avec une route par defaut, elle nomme le saut suivant`, async () => {
      const { cli } = await faire();
      await taper(cli, [
        'configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end',
      ]);

      expect(await cli.executeCommand('show ip route'))
        .toMatch(/Gateway of last resort is 10\.0\.0\.2 to network 0\.0\.0\.0/);
    });

    it(`${nom} — la route par defaut porte l etoile de candidate`, async () => {
      const { cli } = await faire();
      await taper(cli, [
        'configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end',
      ]);

      expect(await cli.executeCommand('show ip route'))
        .toMatch(/^S\*\s+0\.0\.0\.0\/0 /m);
    });
  }
});

describe('une interface adressee produit la connectee ET la locale', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`C\` porte le prefixe et nomme l interface`, async () => {
      const { cli, iface } = await faire();

      expect(await cli.executeCommand('show ip route'))
        .toMatch(new RegExp(`^C\\s+10\\.0\\.0\\.0/24 is directly connected, ${iface}$`, 'm'));
    });

    it(`${nom} — \`L\` porte l adresse en /32`, async () => {
      const { cli, iface } = await faire();

      expect(await cli.executeCommand('show ip route'))
        .toMatch(new RegExp(`^L\\s+10\\.0\\.0\\.1/32 is directly connected, ${iface}$`, 'm'));
    });

    it(`${nom} — le reseau majeur annonce son decoupage`, async () => {
      const { cli } = await faire();

      expect(await cli.executeCommand('show ip route'))
        .toMatch(/10\.0\.0\.0\/8 is variably subnetted, \d+ subnets, \d+ masks/);
    });
  }
});

describe('une route statique porte sa distance et sa metrique', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`[1/0] via <saut>\``, async () => {
      const { cli } = await avecStatique(faire);

      expect(await cli.executeCommand('show ip route'))
        .toMatch(/^S\s+192\.168\.9\.0\/24 \[1\/0\] via 10\.0\.0\.2/m);
    });

    it(`${nom} — une statique FLOTTANTE garde sa distance`, async () => {
      const { cli } = await faire();
      await taper(cli, [
        'configure terminal',
        'ip route 192.168.9.0 255.255.255.0 10.0.0.2 200',
        'end',
      ]);

      expect(await cli.executeCommand('show ip route'))
        .toMatch(/^S\s+192\.168\.9\.0\/24 \[200\/0\] via 10\.0\.0\.2/m);
    });
  }
});

describe('`show ip route <protocole>` filtre', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`static\` ne rend que les statiques`, async () => {
      const { cli } = await avecStatique(faire);
      const vue = await cli.executeCommand('show ip route static');

      expect(vue).toContain('192.168.9.0');
      expect(vue).not.toMatch(/^C\s+10\.0\.0\.0\/24/m);
    });

    it(`${nom} — \`connected\` ne rend que les connectees`, async () => {
      const { cli } = await avecStatique(faire);
      const vue = await cli.executeCommand('show ip route connected');

      expect(vue).toMatch(/10\.0\.0\.0\/24/);
      expect(vue).not.toMatch(/^S\s+192\.168\.9\.0/m);
    });

    it(`${nom} — un protocole qui n a rien rend une vue vide de routes`, async () => {
      const { cli } = await faire();
      const vue = await cli.executeCommand('show ip route ospf');

      expect(vue).not.toMatch(REFUS);
      expect(vue).not.toMatch(/^O\s/m);
    });
  }
});

describe('`show ip route <prefixe>` rend le detail d une seule route', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — il nomme le reseau et son masque`, async () => {
      const { cli } = await avecStatique(faire);

      expect(await cli.executeCommand('show ip route 192.168.9.0'))
        .toMatch(/Routing entry for 192\.168\.9\.0\/24/);
    });

    it(`${nom} — il dit par ou le paquet SORT`, async () => {
      const { cli } = await avecStatique(faire);
      const vue = await cli.executeCommand('show ip route 192.168.9.0');

      expect(vue).toContain('Routing Descriptor Blocks:');
      expect(vue).toContain('10.0.0.2');
    });

    it(`${nom} — un prefixe inconnu le dit`, async () => {
      const { cli } = await faire();

      expect(await cli.executeCommand('show ip route 203.0.113.7'))
        .toMatch(/Network not in table/);
    });
  }
});

describe('la vue est joignable depuis l EXEC UTILISATEUR', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — sans \`enable\``, async () => {
      const d = nom === 'routeur'
        ? new CiscoRouter(`R${serie++}`, 0, 0) as unknown as Cli
        : new CiscoSwitch('switch-cisco', `SW${serie++}`, 8, 0, 0) as unknown as Cli;
      (d as unknown as { powerOn(): void }).powerOn();

      expect(await d.executeCommand('show ip route')).not.toMatch(REFUS);
      void faire;
    });
  }
});
