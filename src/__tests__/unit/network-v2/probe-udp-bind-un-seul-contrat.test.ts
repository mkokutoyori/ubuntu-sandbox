import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface UdpHost {
  udpBind(port: number, handler: (d: unknown) => void): boolean;
  udpClose(port: number): void;
}

function linuxHost(): UdpHost & { executeCommand(c: string): Promise<string> } {
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  return pc as unknown as UdpHost & { executeCommand(c: string): Promise<string> };
}

function routerEndpoint(): UdpHost {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return (r as unknown as { getUdpEndpoint(): UdpHost })
    .getUdpEndpoint();
}

describe('un port libre se lie, et le dit', () => {
  it('sur un hote Linux', () => {
    expect(linuxHost().udpBind(5000, () => { /* ecoute */ })).toBe(true);
  });

  it('sur le point d acces du plan de controle d un routeur', () => {
    expect(routerEndpoint().udpBind(5000, () => { /* ecoute */ })).toBe(true);
  });
});

describe('un port DEJA pris est refuse, et les deux hotes le refusent PAREIL', () => {
  it('l hote Linux rend false plutot que de lever', () => {
    const host = linuxHost();
    host.udpBind(5000, () => { /* premier */ });

    expect(host.udpBind(5000, () => { /* second */ })).toBe(false);
  });

  it('le point d acces du routeur rend false', () => {
    const ep = routerEndpoint();
    ep.udpBind(5000, () => { /* premier */ });

    expect(ep.udpBind(5000, () => { /* second */ })).toBe(false);
  });

  it('et aucun des deux ne leve', () => {
    const host = linuxHost();
    const ep = routerEndpoint();
    host.udpBind(5000, () => { /* premier */ });
    ep.udpBind(5000, () => { /* premier */ });

    expect(() => host.udpBind(5000, () => { /* second */ })).not.toThrow();
    expect(() => ep.udpBind(5000, () => { /* second */ })).not.toThrow();
  });
});

describe('le refus ne detruit pas la liaison en place', () => {
  it('le PREMIER auditeur recoit toujours', async () => {
    const server = new LinuxPC('linux-pc', 'SERVEUR', 200, 0);
    const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
    server.powerOn();
    client.powerOn();
    new Cable('lien').connect(client.getPort('eth0')!, server.getPort('eth0')!);
    for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
      await client.executeCommand(c);
    }
    for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) {
      await server.executeCommand(c);
    }
    const recus: unknown[] = [];
    (server as unknown as UdpHost).udpBind(5000, (d) => { recus.push(d); });
    (server as unknown as UdpHost).udpBind(5000, () => { recus.push('IMPOSTEUR'); });

    (client as unknown as {
      sendUdpDatagram(ip: IPAddress, dp: number, sp: number, p: unknown): boolean;
    }).sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'salut');

    expect(recus).toHaveLength(1);
    expect(recus[0]).not.toBe('IMPOSTEUR');
  });

  it('et le port reste occupe pour `ss -lun`', async () => {
    const host = linuxHost();
    host.udpBind(5000, () => { /* premier */ });
    host.udpBind(5000, () => { /* refuse */ });

    expect(await host.executeCommand('ss -lun')).toMatch(/5000/);
  });
});

describe('libérer rend le port disponible', () => {
  it('sur un hote Linux', () => {
    const host = linuxHost();
    host.udpBind(5000, () => { /* premier */ });
    host.udpClose(5000);

    expect(host.udpBind(5000, () => { /* second */ })).toBe(true);
  });

  it('sur le point d acces du routeur', () => {
    const ep = routerEndpoint();
    ep.udpBind(5000, () => { /* premier */ });
    ep.udpClose(5000);

    expect(ep.udpBind(5000, () => { /* second */ })).toBe(true);
  });
});
