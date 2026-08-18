import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
}

let serial = 0;

const PLATEFORMES: Array<[string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serial++}`) as unknown as Cli],
  ['commutateur', () => createDevice('switch-cisco', 0, 0) as unknown as Cli],
];

async function privileged(make: () => Cli): Promise<Cli> {
  const device = make();
  await device.executeCommand('enable');
  return device;
}

const VUES = [
  'show ip dhcp pool',
  'show ip dhcp binding',
  'show ip dhcp conflict',
  'show ip dhcp excluded-address',
  'show ip dhcp server statistics',
  'show ip dhcp relay statistics',
];

const EFFACEMENTS = [
  'clear ip dhcp binding *',
  'clear ip dhcp conflict *',
  'clear ip dhcp server statistics',
];

describe.each(PLATEFORMES)('%s — les vues restent au niveau 1', (_nom, make) => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await make().executeCommand(command)).not.toContain('Invalid input');
  });

  it.each(EFFACEMENTS)('`%s` reste privilegiee', async (command) => {
    expect(await make().executeCommand(command)).toContain('Invalid input');
  });

  it.each(EFFACEMENTS)('et acceptee en EXEC privilegie — `%s`', async (command) => {
    expect(await (await privileged(make)).executeCommand(command)).toBe('');
  });
});

describe('les deux plateformes rendent le MEME texte pour la meme vue', () => {
  it.each(VUES)('`%s`', async (command) => {
    const routeur = await privileged(PLATEFORMES[0][1]);
    const commutateur = await privileged(PLATEFORMES[1][1]);

    expect(await commutateur.executeCommand(command))
      .toBe(await routeur.executeCommand(command));
  });
});

describe('`show ip dhcp binding` porte l\'en-tete d\'IOS', () => {
  it.each(PLATEFORMES)('%s — la ligne des pools sans VRF', async (_nom, make) => {
    const sortie = await (await privileged(make)).executeCommand('show ip dhcp binding');

    expect(sortie).toContain('Bindings from all pools not associated with VRF:');
    expect(sortie).toContain('IP address');
    expect(sortie).toContain('Lease expiration');
  });
});

describe('`show ip dhcp relay statistics` MESURE, elle ne recopie plus le serveur', () => {
  async function relayLab() {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const relay = new CiscoRouter('RELAY');
    const server = new CiscoRouter('SERVER');
    new Cable('a').connect(h1.getPort('eth0')!, relay.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(relay.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
    const run = async (d: { executeCommand(c: string): Promise<string> }, cmds: string[]) => {
      for (const c of cmds) await d.executeCommand(c);
    };
    await run(relay, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/0', 'ip helper-address 10.0.12.2', 'exit', 'end']);
    await run(server, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
      'ip route 10.0.1.0 255.255.255.0 10.0.12.1',
      'ip dhcp pool REMOTE', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1', 'exit',
      'ip dhcp excluded-address 10.0.1.1', 'end']);
    return { h1, relay, server };
  }

  function compteur(texte: string, etiquette: string): number {
    const ligne = texte.split('\n').find(l => l.startsWith(etiquette));
    return ligne ? Number(ligne.replace(etiquette, '').trim()) : -1;
  }

  it('les compteurs sont a zero avant tout trafic', async () => {
    const { relay } = await relayLab();

    const avant = await relay.executeCommand('show ip dhcp relay statistics');

    expect(compteur(avant, 'Requests forwarded')).toBe(0);
    expect(compteur(avant, 'Replies forwarded')).toBe(0);
  });

  it('et ils MONTENT quand un vrai bail traverse le relais', async () => {
    const { h1, relay } = await relayLab();

    await h1.executeCommand('dhclient -v eth0');
    const apres = await relay.executeCommand('show ip dhcp relay statistics');

    expect(compteur(apres, 'Requests forwarded')).toBeGreaterThan(0);
  });

  it('elle ne rend PLUS le texte du serveur — le defaut corrige', async () => {
    const { relay } = await relayLab();

    const relais = await relay.executeCommand('show ip dhcp relay statistics');
    const serveur = await relay.executeCommand('show ip dhcp server statistics');

    expect(relais).not.toBe(serveur);
    expect(relais).not.toContain('Memory usage');
    expect(relais).toContain('DHCP Relay Statistics');
  });

  it('le SERVEUR, lui, garde ses propres compteurs — le temoin', async () => {
    const { relay } = await relayLab();

    expect(await relay.executeCommand('show ip dhcp server statistics'))
      .toContain('Memory usage');
  });
});

describe('`clear ip dhcp` efface pour de bon', () => {
  it('`clear ip dhcp server statistics` remet les compteurs a zero', async () => {
    const device = await privileged(PLATEFORMES[0][1]);

    await device.executeCommand('clear ip dhcp server statistics');
    const apres = await device.executeCommand('show ip dhcp server statistics');

    expect(apres).toContain('DHCPDISCOVER         0');
  });

  it('et le commutateur y repond aussi — il porte le meme serveur', async () => {
    const device = await privileged(PLATEFORMES[1][1]);

    expect(await device.executeCommand('clear ip dhcp server statistics')).toBe('');
  });

  it('`clear ip dhcp binding` sans cible est incomplete', async () => {
    expect(await (await privileged(PLATEFORMES[0][1])).executeCommand('clear ip dhcp binding'))
      .toContain('Incomplete');
  });
});

describe('l\'aide propose la meme famille des deux cotes', () => {
  it.each(['binding', 'conflict', 'excluded-address', 'pool', 'relay', 'server'])(
    '`show ip dhcp ?` propose `%s` sur les deux plateformes', async (mot) => {
      for (const [, make] of PLATEFORMES) {
        expect((await privileged(make)).cliHelp('show ip dhcp ')).toContain(mot);
      }
    });
});
