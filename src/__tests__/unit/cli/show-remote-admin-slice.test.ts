import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  _getSshKnownHosts(): {
    add(entry: { host: string; keyType: string; publicKey: string }): void;
  };
}

let serial = 0;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `SW${serial++}`, 24, 0, 0) as unknown as Cli],
];

const VUES = [
  'show ip ssh',
  'show ip ssh known-hosts',
  'show ssh',
  'show ip http server status',
  'show ip http server all',
];

async function nu(faire: () => Cli): Promise<Cli> {
  const device = faire();
  device.powerOn();
  return device;
}

async function privilegie(faire: () => Cli): Promise<Cli> {
  const device = await nu(faire);
  await device.executeCommand('enable');
  return device;
}

for (const [nom, faire] of PLATEFORMES) {
  describe(`${nom} — les cinq vues restent privilegiees`, () => {
    it.each(VUES)('`%s` est refusee en EXEC utilisateur', async (command) => {
      expect(await (await nu(faire)).executeCommand(command))
        .toContain('% Invalid input');
    });

    it.each(VUES)('`%s` repond en EXEC privilegie', async (command) => {
      expect(await (await privilegie(faire)).executeCommand(command))
        .not.toContain('% Invalid input');
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  it('`show ip ssh` decrit le meme serveur', async () => {
    const routeur = await privilegie(PLATEFORMES[0][1]);
    const commutateur = await privilegie(PLATEFORMES[1][1]);
    expect(await commutateur.executeCommand('show ip ssh'))
      .toBe(await routeur.executeCommand('show ip ssh'));
  });

  it('`show ip ssh known-hosts` rend son en-tete des deux cotes', async () => {
    const entete = 'Address          Key fingerprint'
      + '                                   Type';
    for (const [, faire] of PLATEFORMES) {
      expect(await (await privilegie(faire)).executeCommand('show ip ssh known-hosts'))
        .toBe(entete);
    }
  });

  it('`show ip http server status` decrit le meme serveur', async () => {
    const routeur = await privilegie(PLATEFORMES[0][1]);
    const commutateur = await privilegie(PLATEFORMES[1][1]);
    expect(await commutateur.executeCommand('show ip http server status'))
      .toBe(await routeur.executeCommand('show ip http server status'));
  });
});

describe('un commutateur RETIENT desormais la cle qu\'il apprend', () => {
  it('la vue liste ce que le magasin du commutateur porte', async () => {
    const commutateur = await privilegie(PLATEFORMES[1][1]);
    commutateur._getSshKnownHosts().add({
      host: '10.0.0.1', keyType: 'ssh-rsa', publicKey: 'AAAAB3NzaC1yc2EAAAA',
    });
    const rendu = await commutateur.executeCommand('show ip ssh known-hosts');
    expect(rendu).toContain('10.0.0.1');
    expect(rendu).toContain('ssh-rsa');
  });
});

describe('l\'aide decrit le noeud et non son premier descendant', () => {
  it.each(PLATEFORMES.map(([nom]) => nom))(
    '`show ip http ?` sur %s', async (nom) => {
      const faire = PLATEFORMES.find(([n]) => n === nom)![1];
      const ligne = (await privilegie(faire)).cliHelp('show ip http ')
        .split('\n').find((l) => l.trim().startsWith('server'))!;
      expect(ligne).toContain('HTTP server information');
    });

  it('`show ip http server ?` propose ses deux vues', async () => {
    const aide = (await privilegie(PLATEFORMES[0][1])).cliHelp('show ip http server ');
    expect(aide).toContain('status');
    expect(aide).toContain('all');
  });

  it('`show ip ssh ?` propose `known-hosts` et `<cr>`', async () => {
    const aide = (await privilegie(PLATEFORMES[0][1])).cliHelp('show ip ssh ');
    expect(aide).toContain('known-hosts');
    expect(aide).toContain('<cr>');
  });
});

describe('les contrats deja tenus le restent', () => {
  it('`show ssh sessions` rend la meme chose que `show ssh`', async () => {
    const device = await privilegie(PLATEFORMES[0][1]);
    expect(await device.executeCommand('show ssh sessions'))
      .toBe(await device.executeCommand('show ssh'));
  });

  it('`show ssh` annonce les deux versions sans session ouverte', async () => {
    expect(await (await privilegie(PLATEFORMES[0][1])).executeCommand('show ssh'))
      .toContain('%No SSHv2 server connections running.');
  });
});
