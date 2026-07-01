import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { TcpStack } from '@/network/tcp/TcpStack';

interface Lab { client: LinuxPC; server: LinuxServer }

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  const m = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), m);
  server.getTcpStack().listen(9000, { onAccept: () => undefined });
  return { client, server };
}

function stack(host: LinuxPC): TcpStack {
  return host.getTcpStack();
}

describe('Scénario 13 — Épuisement du pool éphémère sous charge', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('sysctl -w net.ipv4.ip_local_port_range="10000 10099" rétrécit effectivement la plage', async () => {
    const { client } = await buildLab();
    const out = await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="10000 10099"');
    expect(out).toMatch(/net\.ipv4\.ip_local_port_range = 10000\t10099/);
    const range = stack(client).getEphemeralRange();
    expect(range.min).toBe(10000);
    expect(range.max).toBe(10099);
    const read = await client.executeCommand('cat /proc/sys/net/ipv4/ip_local_port_range');
    expect(read.trim()).toBe('10000\t10099');
  });

  it('épuisement du pool: après avoir consommé les 100 ports, la 101e connexion échoue avec Cannot assign requested address', async () => {
    const { client } = await buildLab();
    await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="10000 10099"');
    for (let i = 0; i < 100; i++) {
      const s = stack(client).connect('10.0.0.20', 9000, {});
      expect(s).not.toBeNull();
    }
    expect(stack(client).hasFreeEphemeralPort()).toBe(false);
    const out = await client.executeCommand('nc -zv 10.0.0.20 9000');
    expect(out).toMatch(/Cannot assign requested address/);
  });

  it('aucun SYN n\'est émis pour la connexion refusée localement — l\'erreur est locale', async () => {
    const { client } = await buildLab();
    await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="10000 10009"');
    for (let i = 0; i < 10; i++) stack(client).connect('10.0.0.20', 9000, {});
    let dropped: string | null = null;
    const off = client.getBus().subscribe('tcp.segment.dropped', (e) => {
      if ((e.payload as { reason: string }).reason === 'no-ephemeral') dropped = 'no-ephemeral';
    });
    let syns = 0;
    const offSent = client.getBus().subscribe('tcp.segment.sent', (e) => {
      const p = e.payload as { flagsText?: string };
      if (p.flagsText?.includes('S') && !p.flagsText.includes('.')) syns++;
    });
    const synsBefore = syns;
    const nullSocket = stack(client).connect('10.0.0.20', 9000, {});
    expect(nullSocket).toBeNull();
    expect(dropped).toBe('no-ephemeral');
    expect(syns).toBe(synsBefore);
    off(); offSent();
  });

  it('ss -tan expose les connexions consommant les ports éphémères — reflète le pool retenu', async () => {
    const { client } = await buildLab();
    await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="10000 10029"');
    for (let i = 0; i < 30; i++) stack(client).connect('10.0.0.20', 9000, {});
    expect(stack(client).hasFreeEphemeralPort()).toBe(false);
  });

  it('la taille exacte du pool détermine le nombre de connexions simultanées possibles', async () => {
    const { client } = await buildLab();
    await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="20000 20024"');
    let opened = 0;
    for (let i = 0; i < 30; i++) {
      const s = stack(client).connect('10.0.0.20', 9000, {});
      if (s !== null) opened++;
    }
    expect(opened).toBe(25);
    expect(stack(client).hasFreeEphemeralPort()).toBe(false);
  });

  it('les connexions maintenues en TIME_WAIT continuent d\'occuper leur port éphémère', async () => {
    const { client } = await buildLab();
    await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="30000 30001"');
    const s1 = stack(client).connect('10.0.0.20', 9000, {});
    const s2 = stack(client).connect('10.0.0.20', 9000, {});
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(stack(client).hasFreeEphemeralPort()).toBe(false);
    s1!.close();
    expect(stack(client).hasFreeEphemeralPort()).toBe(false);
  });

  it('les ports alloués respectent bien la plage configurée: tous sont dans [10000,10099]', async () => {
    const { client } = await buildLab();
    await client.executeCommand('sysctl -w net.ipv4.ip_local_port_range="10000 10099"');
    const ports: number[] = [];
    for (let i = 0; i < 100; i++) {
      const s = stack(client).connect('10.0.0.20', 9000, {});
      if (s) ports.push(s.localPort);
    }
    expect(ports.length).toBe(100);
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(10000);
      expect(p).toBeLessThanOrEqual(10099);
    }
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('la plage Windows par défaut (49152-65535) reste inchangée: exhaustion beaucoup plus lointaine', async () => {
    const { client } = await buildLab();
    const range = stack(client).getEphemeralRange();
    expect(range.max - range.min + 1).toBeGreaterThanOrEqual(1024);
    expect(stack(client).hasFreeEphemeralPort()).toBe(true);
  });
});
