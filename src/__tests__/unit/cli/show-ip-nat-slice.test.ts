import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, createIPv4Packet, IP_PROTO_TCP, resetCounters,
} from '@/network/core/types';
import type { TCPPacket, IPv4Packet } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { NATEngine } from '@/network/devices/router/NATEngine';
import { inspectAndRewriteFtpAlg } from '@/network/devices/router/nat/FtpAlg';
import { encodeCommand } from '@/network/ftp/replies';
import { encodePortArgument } from '@/network/ftp/DataChannel';
import { MACAddress } from '@/network/core/types';
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
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privilegie(): Promise<Cli> {
  const device = nu();
  await device.executeCommand('enable');
  return device;
}

const VUES = [
  'show ip nat translations',
  'show ip nat translations verbose',
  'show ip nat translations timeout',
  'show ip nat nvi translations',
  'show ip nat statistics',
];

describe('les vues restent au niveau 1, l\'effacement au niveau 15', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });

  it('`clear ip nat translation *` reste privilegiee', async () => {
    expect(await nu().executeCommand('clear ip nat translation *')).toContain('Invalid input');
    expect(await (await privilegie()).executeCommand('clear ip nat translation *')).toBe('');
  });
});

describe('l\'aide decrit chaque branche', () => {
  it('`show ip nat ?` ne propose plus `nvi` sans description', async () => {
    const aide = (await privilegie()).cliHelp('show ip nat ');
    const ligne = aide.split('\n').find(l => l.trim().startsWith('nvi'));

    expect(ligne).toBeDefined();
    expect(ligne!.replace(/^\s*nvi\s*/, '').trim().length).toBeGreaterThan(0);
  });

  it.each(['nvi', 'statistics', 'translations'])('`show ip nat ?` propose `%s`', async (mot) => {
    expect((await privilegie()).cliHelp('show ip nat ')).toContain(mot);
  });

  it.each(['timeout', 'verbose', 'vrf'])(
    '`show ip nat translations ?` propose `%s`', async (mot) => {
      expect((await privilegie()).cliHelp('show ip nat translations ')).toContain(mot);
    });

  it.each([
    ['show ip nat trans', 'show ip nat translations'],
    ['show ip nat stat', 'show ip nat statistics'],
  ])('`%s` se complete en `%s`', async (frappe, attendu) => {
    expect((await privilegie()).cliTabCandidates(frappe)).toContain(attendu);
  });

  it('un mot inconnu est refuse', async () => {
    expect(await (await privilegie()).executeCommand('show ip nat zorglub'))
      .toContain('Invalid input');
  });
});

describe('`show ip nat statistics` rend le bloc d\'IOS, pas une ligne inventee', () => {
  it('les quatre compteurs de portes sont la', async () => {
    const sortie = await (await privilegie()).executeCommand('show ip nat statistics');

    for (const ligne of ['Total doors:', 'Appl doors:', 'Normal doors:', 'Queued Packets:']) {
      expect(sortie, ligne).toContain(ligne);
    }
  });

  it('et la ligne inventee a disparu', async () => {
    expect(await (await privilegie()).executeCommand('show ip nat statistics'))
      .not.toContain('Application Layer Gateways');
  });

  it('les en-tetes historiques sont conserves — le temoin', async () => {
    const sortie = await (await privilegie()).executeCommand('show ip nat statistics');

    expect(sortie).toContain('Total active translations:');
    expect(sortie).toContain('Inside interfaces:');
    expect(sortie).toContain('Hits:');
  });
});

describe('`Appl doors` MESURE les portes que l\'ALG ouvre vraiment', () => {
  function paquetFtp(text: string): IPv4Packet {
    const tcp: TCPPacket = {
      type: 'tcp', sourcePort: 21000, destinationPort: 21,
      sequenceNumber: 1000, acknowledgementNumber: 0,
      flags: { syn: false, ack: true, fin: false, rst: false, psh: true, urg: false },
      windowSize: 65535, checksum: 0, payload: text,
    };
    return createIPv4Packet(
      new IPAddress('10.0.1.2'), new IPAddress('203.0.113.50'),
      IP_PROTO_TCP, 64, tcp, 40 + text.length);
  }

  it('elle vaut zero avant toute commande PORT', () => {
    expect(new NATEngine().getAlgDoors()).toBe(0);
  });

  it('et elle MONTE quand une commande PORT ouvre une porte', () => {
    const engine = new NATEngine();
    const portCmd = encodeCommand({ verb: 'PORT', argument: encodePortArgument('10.0.1.2', 40000) });

    inspectAndRewriteFtpAlg(paquetFtp(portCmd), engine, '198.51.100.1');

    expect(engine.getAlgDoors()).toBe(1);
  });

  it('une seconde commande PORT ouvre une seconde porte', () => {
    const engine = new NATEngine();

    inspectAndRewriteFtpAlg(
      paquetFtp(encodeCommand({ verb: 'PORT', argument: encodePortArgument('10.0.1.2', 40000) })),
      engine, '198.51.100.1');
    inspectAndRewriteFtpAlg(
      paquetFtp(encodeCommand({ verb: 'PORT', argument: encodePortArgument('10.0.1.2', 40001) })),
      engine, '198.51.100.1');

    expect(engine.getAlgDoors()).toBe(2);
  });

  it('l\'ALG desactive n\'ouvre aucune porte — le temoin', () => {
    const engine = new NATEngine();
    engine.setAlgEnabled('ftp', false);

    inspectAndRewriteFtpAlg(
      paquetFtp(encodeCommand({ verb: 'PORT', argument: encodePortArgument('10.0.1.2', 40000) })),
      engine, '198.51.100.1');

    expect(engine.getAlgDoors()).toBe(0);
  });

  it('un paquet qui n\'est pas du FTP n\'ouvre rien — le second temoin', () => {
    const engine = new NATEngine();

    inspectAndRewriteFtpAlg(paquetFtp('bonjour'), engine, '198.51.100.1');

    expect(engine.getAlgDoors()).toBe(0);
  });
});

describe('le commutateur n\'a pas NAT, et ne l\'a toujours pas', () => {
  it.each(['show ip nat translations', 'show ip nat statistics'])(
    '`%s` y reste refusee', async (command) => {
      const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
      await device.executeCommand('enable');

      expect(await device.executeCommand(command)).toContain('Invalid input');
    });
});
