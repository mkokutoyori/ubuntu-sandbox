/*
 * Sonde -- le serveur SSH parle la couche transport de la RFC 4253 sur le
 * fil, avec l'identification de SA plateforme.
 *
 * MESURE DE DEPART (base `origin/mandeng'). Un client TCP brut ouvert vers
 * le port 22 lisait :
 *   - Linux : `SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6\r\n', ecrit par
 *     l'ecouteur TCP lui-meme, puis RIEN : le serveur attendait une
 *     enveloppe JSON `{"op":"hello"}' et ne parlait jamais SSH ;
 *   - Windows, Cisco, Huawei : RIEN du tout, aucune identification.
 * Le seul octet SSH du fil etait une banniere decorative ; la negociation,
 * la cle d'hote et le chiffrement vivaient dans du JSON.
 *
 * AUTORITES. RFC 4253 §4.2 (identification), §6 (paquet binaire), §7
 * (KEXINIT, dix name-lists), §7.1 (une MAC est negociee meme quand le
 * chiffre est AEAD : un pair strict refuse une liste vide -- paramiko 5.0
 * repond « Incompatible ssh server (no acceptable macs) », mesure).
 * OpenSSH 8.9p1 `myproposal.h' pour l'ordre des listes, `kex.c'
 * (`kex_exchange_identification', SSH_VERSION) pour l'identification,
 * Win32-OpenSSH v8.6.0.0 `version.h' (SSH_VERSION
 * « OpenSSH_for_Windows_8.6 », sans « p1 »). Cisco : « SSH-1.99-Cisco-1.25 »
 * tant que `ip ssh version 2' n'est pas pose, « SSH-2.0-Cisco-1.25 »
 * ensuite (forums Cisco, 1.99 = compatibilite v1/v2). Huawei VRP :
 * « SSH-2.0-HUAWEI-1.5 » (journaux de clients publies).
 *
 * L'implantation a en outre ete eprouvee HORS DEPOT contre deux SSH
 * independants sur une vraie socket locale : paramiko 5.0 (client et
 * serveur) et asyncssh 2.24 (serveur) -- curve25519 x2, ecdh-nistp256,
 * DH group1/14-sha1/14-sha256/16/18, chacha20-poly1305, aes-gcm 128/256,
 * aes-ctr 128/192/256, hmac-sha1/sha2-256/sha2-512 en E&M et en ETM, cles
 * d'hote ed25519, ECDSA et rsa-sha2-512.
 *
 * DISCRIMINATION (`git stash' des fichiers suivis) : 9 des 10 cas tombent avant
 * le correctif. Passe des deux cotes le TEMOIN : le serveur Linux s'annonce
 * une seule fois par la ligne d'OpenSSH Ubuntu -- l'ecouteur l'ecrivait
 * deja ; il prouve que le laboratoire joint bien le port 22.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { TcpStream } from '@/network/tcp/types';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { binaryStringToBytes } from '@/crypto/encoding';
import { SshReader } from '@/network/protocols/ssh/wire/SshDataTypes';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Lab { client: LinuxPC; cisco: CiscoRouter }

const MASK = new SubnetMask('255.255.255.0');

async function lab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'PC', 0, 0);
  const linux = new LinuxServer('linux-server', 'SRV', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const cisco = new CiscoRouter('R1', 0, 0);
  const huawei = new HuaweiRouter('AR1');
  const ports = sw.getPorts();
  [client.getPort('eth0')!, linux.getPort('eth0')!, windows.getPorts()[0], cisco.getPorts()[0],
    huawei.getPort('GE0/0/0')!].forEach((port, i) => new Cable(`c${i}`).connect(port, ports[i]));
  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  linux.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), MASK);
  windows.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
  await linux.executeCommand('sudo systemctl start ssh');
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Cisco123', 'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048', 'line vty 0 4', 'login local', 'transport input ssh', 'exit', 'end',
  ]) await cisco.executeCommand(c);
  for (const c of ['system-view', 'interface GigabitEthernet 0/0/0', 'ip address 10.0.0.4 24', 'undo shutdown', 'quit',
    'aaa', 'local-user admin password cipher Admin@123', 'local-user admin service-type ssh', 'quit',
    'rsa local-key-pair create', 'stelnet server enable',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit', 'return',
  ]) await huawei.executeCommand(c);
  await settle();
  return { client, cisco };
}

async function connect(client: LinuxPC, ip: string): Promise<TcpStream> {
  const socket = await (client as unknown as {
    tcpConnect(ip: string, port: number): Promise<TcpStream | null>;
  }).tcpConnect(ip, 22);
  expect(socket).toBeTruthy();
  return socket!;
}

async function firstBytes(client: LinuxPC, ip: string): Promise<string> {
  const socket = await connect(client, ip);
  const chunks: string[] = [];
  socket.onData((d) => { chunks.push(d); });
  await settle();
  socket.close();
  return chunks.join('');
}

function firstLine(bytes: string): string {
  return bytes.slice(0, bytes.indexOf('\r\n'));
}

function kexInitLists(bytes: string): string[][] {
  const packet = binaryStringToBytes(bytes.slice(bytes.indexOf('\r\n') + 2));
  const reader = new SshReader(packet);
  const packetLength = reader.readUint32();
  const padding = reader.readByte();
  const payload = new SshReader(packet.subarray(5, 4 + packetLength - padding));
  expect(payload.readByte()).toBe(20);
  payload.readRaw(16);
  return Array.from({ length: 10 }, () => payload.readString().split(',').filter((n) => n !== ''));
}

describe('le serveur s annonce et negocie comme le vrai', () => {
  it('TEMOIN -- Linux s annonce une seule fois, comme OpenSSH 8.9p1 Ubuntu', async () => {
    const { client } = await lab();
    const bytes = await firstBytes(client, '10.0.0.2');

    expect(firstLine(bytes)).toBe('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6');
    expect(bytes.split('SSH-2.0-').length - 1).toBe(1);
  });

  it('Linux enchaine sur un SSH_MSG_KEXINIT binaire', async () => {
    const { client } = await lab();
    const lists = kexInitLists(await firstBytes(client, '10.0.0.2'));

    expect(lists[0].slice(0, 3)).toEqual(['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256']);
  });

  it('le KEXINIT offre chacha20-poly1305 en tete et une liste de MAC non vide', async () => {
    const { client } = await lab();
    const lists = kexInitLists(await firstBytes(client, '10.0.0.2'));

    expect(lists[2][0]).toBe('chacha20-poly1305@openssh.com');
    expect(lists[4]).toContain('hmac-sha2-256-etm@openssh.com');
  });

  it('Windows s annonce comme Win32-OpenSSH 8.6', async () => {
    const { client } = await lab();

    expect(firstLine(await firstBytes(client, '10.0.0.3'))).toBe('SSH-2.0-OpenSSH_for_Windows_8.6');
  });

  it('IOS s annonce en 1.99 tant que `ip ssh version 2` n est pas pose', async () => {
    const { client } = await lab();

    expect(firstLine(await firstBytes(client, '10.0.0.1'))).toBe('SSH-1.99-Cisco-1.25');
  });

  it('IOS s annonce en 2.0 apres `ip ssh version 2`', async () => {
    const { client, cisco } = await lab();
    for (const c of ['enable', 'configure terminal', 'ip ssh version 2', 'end']) await cisco.executeCommand(c);

    expect(firstLine(await firstBytes(client, '10.0.0.1'))).toBe('SSH-2.0-Cisco-1.25');
  });

  it('VRP s annonce comme HUAWEI-1.5', async () => {
    const { client } = await lab();

    expect(firstLine(await firstBytes(client, '10.0.0.4'))).toBe('SSH-2.0-HUAWEI-1.5');
  });

  it('un client RFC 4253 independant du serveur etablit la session chiffree', async () => {
    const { client } = await lab();
    const transport = new SshTransport(await connect(client, '10.0.0.2'), {
      role: 'client', identification: 'SSH-2.0-probe',
    });
    const outcome = await transport.established;

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.algorithms.encryptionClientToServer).toBe('chacha20-poly1305@openssh.com');
  });

  it('la cle d hote prouvee pendant l echange est celle que ssh-keyscan rapporte', async () => {
    const { client } = await lab();
    const transport = new SshTransport(await connect(client, '10.0.0.2'), {
      role: 'client', identification: 'SSH-2.0-probe',
    });
    const outcome = await transport.established;
    const keyscan = await client.executeCommand('ssh-keyscan -t ed25519 10.0.0.2 2>/dev/null');

    expect(outcome.ok).toBe(true);
    expect(keyscan.trim().split(/\s+/)[2]).toBe(
      outcome.ok ? Buffer.from(outcome.hostKeyBlob).toString('base64') : 'none');
  });

  it('un octet altere sous chacha20-poly1305 ferme la connexion sans DISCONNECT', async () => {
    const { client } = await lab();
    const socket = await connect(client, '10.0.0.2');
    let writes = 0;
    const tampering: TcpStream = {
      ...socket,
      write: (data: string) => {
        writes++;
        if (writes !== SERVICE_REQUEST_WRITE) { socket.write(data); return; }
        const last = data.length - 1;
        socket.write(data.slice(0, last) + String.fromCharCode(data.charCodeAt(last) ^ 1));
      },
      onData: (handler) => socket.onData(handler),
      onClose: (handler) => socket.onClose!(handler),
      close: () => socket.close(),
    };
    const transport = new SshTransport(tampering, { role: 'client', identification: 'SSH-2.0-probe' });
    const outcome = await transport.established;

    expect(outcome.ok).toBe(false);
    expect('kind' in outcome ? outcome.kind : 'established').toBe('closed');
  });
});

const SERVICE_REQUEST_WRITE = 5;
