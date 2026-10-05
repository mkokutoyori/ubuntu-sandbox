/**
 * Sonde — `ssh -L` / `-R` / `-D` lances par `executeCommand` voyagent dans des
 * CANAUX de la session SSH, et c'est le SERVEUR qui decide.
 *
 * Mesure de depart : ce chemin (`LinuxSshClient` + `SshForwardingTable`)
 * ouvrait sa session SSH pour les commandes, mais ses redirections ne s'en
 * servaient pas. `-L` posait l'ecoute locale et faisait composer la cible par
 * la PILE TCP DU SERVEUR (`dialStack`), sans un seul message `direct-tcpip` ;
 * `-R` posait l'ecoute en ATTEIGNANT l'objet distant (`executor.
 * forwardingTable.open`) ; `-D` n'avait aucun relais ; et l'on lisait
 * `sshd_config` de l'autre machine pour refuser AU MOMENT du `ssh`, alors
 * qu'OpenSSH ne refuse qu'a l'usage (`channel N: open failed`).
 *
 * Mesure avant correctif (la sonde rejouee sur `b53568db4`, un worktree de la
 * base) : 8 cas sur 11 tombent. Passent a l'identique, et c'est dit : le
 * TEMOIN (un forward -L relaie des octets : le labo est sain), « l'ecoute
 * locale est sur la boucle locale, au nom de ssh » (non-regression : la table
 * y posait deja ce pid) et « sans service en face, la connexion locale est
 * refermee » (non-regression).
 *
 * Les numeros de message (80 requete globale, 90 ouverture de canal) et les
 * noms (`direct-tcpip`, `tcpip-forward`, `forwarded-tcpip`) sont ceux de la
 * RFC 4254 §7, ecrits en dur.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { SshReader } from '@/network/protocols/ssh/wire/SshDataTypes';
import { buildLan, assignIps, PC1_IP, PC2_IP, PC3_IP, type SshLan } from './ssh-lan-fixtures';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

interface Message { role: 'client' | 'server'; type: number; name: string }

function observeSshMessages(): Message[] {
  const seen: Message[] = [];
  const send = SshTransport.prototype.send;
  vi.spyOn(SshTransport.prototype, 'send').mockImplementation(function (this: SshTransport, payload: Uint8Array) {
    if (payload[0] === 80 || payload[0] === 90) {
      const reader = new SshReader(payload);
      reader.readByte();
      const role = (this as unknown as { config: { role: 'client' | 'server' } }).config.role;
      seen.push({ role, type: payload[0], name: reader.readString() });
    }
    send.call(this, payload);
  });
  return seen;
}

function echoService(device: SshLan['pc3'], port: number): { accepted: string[]; received: string[] } {
  const accepted: string[] = [];
  const received: string[] = [];
  device.getTcpStack().listen(port, {
    onAccept: (socket) => {
      accepted.push(socket.remoteIp);
      socket.onData((data) => { received.push(String(data)); socket.send(`ECHO:${String(data)}`); });
    },
  });
  return { accepted, received };
}

async function talk(from: SshLan['pc1'], host: string, port: number, payload: string): Promise<string> {
  const replies: string[] = [];
  const socket = from.getTcpStack().connect(host, port, { onData: (data) => replies.push(String(data)) });
  await settle();
  socket?.send(payload);
  await settle();
  return replies.join('');
}

function listenerOn(device: SshLan['pc1'], port: number): { localIp: string } | undefined {
  return device.getTcpStack().listListeners().find((l) => l.localPort === port);
}

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

afterEach(() => { vi.restoreAllMocks(); });

async function restrict(directive: string): Promise<void> {
  const keyword = directive.split(' ')[0];
  await lan.pc2.executeCommand(`sudo sed -i '/^#\\?${keyword}/d' /etc/ssh/sshd_config`);
  await lan.pc2.executeCommand(`echo "${directive}" | sudo tee -a /etc/ssh/sshd_config`);
  await lan.pc2.executeCommand('sudo systemctl restart ssh');
}

describe('ssh -L via executeCommand', () => {
  it('TEMOIN -- un forward -L relaie des octets jusqu\'a la cible', async () => {
    const target = echoService(lan.pc3, 8080);
    await lan.pc1.executeCommand(`ssh -f -N -L 9001:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(await talk(lan.pc1, '127.0.0.1', 9001, 'PING')).toBe('ECHO:PING');
    expect(target.accepted).toEqual([PC2_IP]);
  });

  it('une connexion locale ouvre un canal direct-tcpip, qui est la SEULE facon dont la cible est composee', async () => {
    echoService(lan.pc3, 8080);
    const seen = observeSshMessages();
    await lan.pc1.executeCommand(`ssh -f -N -L 9002:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    await talk(lan.pc1, '127.0.0.1', 9002, 'x');
    expect(seen.filter((m) => m.role === 'client' && m.type === 90 && m.name === 'direct-tcpip')).toHaveLength(1);
  });

  it('l\'ecoute locale est sur la boucle locale, au nom du processus ssh', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -L 9003:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(listenerOn(lan.pc1, 9003)?.localIp).toBe('127.0.0.1');
    expect(await lan.pc1.executeCommand('ss -tlnp')).toMatch(/127\.0\.0\.1:9003\s.*"ssh"/);
  });

  it('sans service en face, la connexion locale est refermee', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -L 9004:${PC3_IP}:9999 user@${PC2_IP}`, 'admin\n');
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 9004)!;
    await settle();
    expect(socket.state).not.toBe('established');
  });

  it('AllowTcpForwarding no : l\'ecoute s\'ouvre sans message, le SERVEUR refuse a l\'usage', async () => {
    await restrict('AllowTcpForwarding no');
    const target = echoService(lan.pc3, 8080);
    const output = await lan.pc1.executeCommand(`ssh -f -N -L 9005:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(output).toBe('');
    expect(listenerOn(lan.pc1, 9005)).toBeDefined();
    expect(await talk(lan.pc1, '127.0.0.1', 9005, 'PING')).toBe('');
    expect(target.accepted).toEqual([]);
  });
});

describe('ssh -D via executeCommand', () => {
  it('un CONNECT SOCKS5 est relaye par un canal direct-tcpip', async () => {
    const target = echoService(lan.pc3, 8081);
    const seen = observeSshMessages();
    await lan.pc1.executeCommand(`ssh -f -N -D 1080 user@${PC2_IP}`, 'admin\n');
    const replies: string[] = [];
    const socket = lan.pc1.getTcpStack().connect('127.0.0.1', 1080, { onData: (data) => replies.push(String(data)) })!;
    await settle();
    socket.send('\x05\x01\x00');
    await settle();
    const ip = PC3_IP.split('.').map((part) => String.fromCharCode(Number(part))).join('');
    socket.send(`\x05\x01\x00\x01${ip}${String.fromCharCode(8081 >> 8)}${String.fromCharCode(8081 & 0xff)}`);
    await settle();
    socket.send('hello');
    await settle();
    expect(replies).toEqual(['\x05\x00', '\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00', 'ECHO:hello']);
    expect(target.accepted).toEqual([PC2_IP]);
    expect(seen.some((m) => m.role === 'client' && m.type === 90 && m.name === 'direct-tcpip')).toBe(true);
  });
});

describe('ssh -R via executeCommand', () => {
  it('le client demande l\'ecoute par une requete globale tcpip-forward, que le serveur pose', async () => {
    const seen = observeSshMessages();
    await lan.pc1.executeCommand(`ssh -f -N -R 9100:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(seen.filter((m) => m.role === 'client' && m.type === 80 && m.name === 'tcpip-forward')).toHaveLength(1);
    expect(listenerOn(lan.pc2, 9100)?.localIp).toBe('127.0.0.1');
    expect(listenerOn(lan.pc1, 9100)).toBeUndefined();
  });

  it('une connexion au port du serveur arrive chez la cible, composee par le CLIENT, par un canal forwarded-tcpip', async () => {
    const target = echoService(lan.pc3, 8080);
    const seen = observeSshMessages();
    await lan.pc1.executeCommand(`ssh -f -N -R 9101:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(await talk(lan.pc2, '127.0.0.1', 9101, 'PONG')).toBe('ECHO:PONG');
    expect(target.accepted).toEqual([PC1_IP]);
    expect(seen.filter((m) => m.role === 'server' && m.type === 90 && m.name === 'forwarded-tcpip')).toHaveLength(1);
  });

  it('AllowTcpForwarding local : le serveur refuse la requete, ssh le dit dans ses mots, aucune ecoute', async () => {
    await restrict('AllowTcpForwarding local');
    const output = await lan.pc1.executeCommand(`ssh -f -N -R 9102:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(output).toContain('Warning: remote port forwarding failed for listen port 9102');
    expect(listenerOn(lan.pc2, 9102)).toBeUndefined();
  });

  it('GatewayPorts yes : le serveur ecoute sur toutes les adresses, quoi qu\'ait demande le client', async () => {
    await restrict('GatewayPorts yes');
    await lan.pc1.executeCommand(`ssh -f -N -R 9103:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(listenerOn(lan.pc2, 9103)?.localIp).toBe('0.0.0.0');
  });
});

describe('fin des redirections', () => {
  it('vider la table du client ferme la session : le serveur retire son ecoute -R et le client la sienne -L', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -R 9104:${PC3_IP}:8080 -L 9105:${PC3_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(listenerOn(lan.pc2, 9104)).toBeDefined();
    expect(listenerOn(lan.pc1, 9105)).toBeDefined();
    (lan.pc1 as unknown as { executor: { forwardingTable: { clear(): void } } }).executor.forwardingTable.clear();
    expect(listenerOn(lan.pc2, 9104)).toBeUndefined();
    expect(listenerOn(lan.pc1, 9105)).toBeUndefined();
  });
});
