/**
 * `nc -x 127.0.0.1:1080 cible port` via le SOCKS5 d'un vrai `ssh -D` : le seul serveur SOCKS du simulateur. Le client SOCKS (ProxyHandshake) parle a
 * SshDynamicForwarder, qui ouvre un canal `direct-tcpip` (RFC 4254 §7.2) sur la session SSH ; la cible voit la connexion arriver du SERVEUR SSH, pas du
 * client. Preuve que les deux moities du protocole, ecrites a part, s'accordent. Avant le lot, `nc -x` etait refuse : 2 cas sur 2 tombent. Aucun temoin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { SshReader } from '@/network/protocols/ssh/wire/SshDataTypes';
import { buildLan, assignIps, PC2_IP, PC3_IP, type SshLan } from './ssh-lan-fixtures';

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

function echoService(device: SshLan['pc3'], port: number): { accepted: string[] } {
  const accepted: string[] = [];
  device.getTcpStack().listen(port, {
    onAccept: (socket) => {
      accepted.push(socket.remoteIp);
      socket.onData((data) => { socket.send(`ECHO:${String(data)}`); });
    },
  });
  return { accepted };
}

function channelOpenings(): string[] {
  const names: string[] = [];
  const send = SshTransport.prototype.send;
  vi.spyOn(SshTransport.prototype, 'send').mockImplementation(function (this: SshTransport, payload: Uint8Array) {
    if (payload[0] === 90) {
      const reader = new SshReader(payload);
      reader.readByte();
      names.push(reader.readString());
    }
    send.call(this, payload);
  });
  return names;
}

describe('nc -x through ssh -D', () => {
  it('reaches the target through a direct-tcpip channel and gets its reply', async () => {
    const target = echoService(lan.pc3, 8081);
    const openings = channelOpenings();
    await lan.pc1.executeCommand(`ssh -f -N -D 1080 user@${PC2_IP}`, 'admin\n');
    const output = await lan.pc1.executeCommand(`printf "hello" | nc -w 1 -x 127.0.0.1:1080 ${PC3_IP} 8081`);
    expect(String(output).trim()).toBe('ECHO:hello');
    expect(target.accepted).toEqual([PC2_IP]);
    expect(openings).toContain('direct-tcpip');
  });

  it('SOCKS5 refused by the tunnel (nothing listens on the target) is reported with the SOCKS5 wording', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -D 1080 user@${PC2_IP}`, 'admin\n');
    const output = await lan.pc1.executeCommand(`nc -w 1 -x 127.0.0.1:1080 ${PC3_IP} 8099`);
    expect(String(output).trim()).toBe('nc: connection failed, SOCKSv5 error: Connection refused');
  });
});
