/**
 * Scenario 9 — Port partagé entre IPv4 et IPv6 (cohérence du dual-stack)
 *
 * Objectif : valider qu'un service configuré pour écouter sur un port donné
 * se comporte de façon cohérente lorsqu'il est accessible à la fois en IPv4
 * et en IPv6 sur le même LAN.
 *
 * Déroulé : configurer un serveur avec dual-stack actif, un service écoutant
 * sur le port 22 en 0.0.0.0 (IPv4) et :: (IPv6), puis tenter des connexions
 * depuis des clients IPv4 et IPv6.
 *
 * Points de contrôle :
 *   - `ss -tlnp` montre les deux sockets en écoute (tcp et tcp6),
 *   - capture réseau confirmant l'établissement réussi dans les deux cas,
 *   - vérification qu'une règle iptables IPv4 ne couvre pas IPv6.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scenario 9 — dual-stack IPv4/IPv6 on port 22', () => {
  let server: LinuxServer;
  let client4: LinuxPC;
  let client6: LinuxPC;
  let sw: HuaweiSwitch;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    client4 = new LinuxPC('linux-pc', 'c4', 0, 0);
    client6 = new LinuxPC('linux-pc', 'c6', 0, 0);
    sw = new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0);
    [server, client4, client6, sw].forEach((d) => d.powerOn());

    const p = Array.from(sw.getPorts().values());
    new Cable('c1').connect(server.getPort('eth0')!, p[0]);
    new Cable('c2').connect(client4.getPort('eth0')!, p[1]);
    new Cable('c3').connect(client6.getPort('eth0')!, p[2]);

    await server.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
    await server.executeCommand('ip -6 addr add fd00::1/64 dev eth0');

    await client4.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');

    await client6.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
  });

  it('ss -tlnp shows sshd listening on BOTH tcp (0.0.0.0:22) and tcp6 ([::]:22)', async () => {
    const out = await server.executeCommand('ss -tlnp');
    const tcp4 = out.split('\n').filter((l) => /0\.0\.0\.0:22\b/.test(l) && /LISTEN/.test(l));
    const tcp6 = out.split('\n').filter((l) => /\[::\]:22\b/.test(l) && /LISTEN/.test(l));
    expect(tcp4.length).toBeGreaterThan(0);
    expect(tcp6.length).toBeGreaterThan(0);
    expect(tcp4[0]).toMatch(/sshd/);
    expect(tcp6[0]).toMatch(/sshd/);
  });

  it('IPv4 client can reach sshd via 192.168.1.1:22 (TCP handshake completes)', async () => {
    const out = await client4.executeCommand('nc -zv 192.168.1.1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('IPv6 client can reach sshd via [fd00::1]:22 (TCP handshake completes)', async () => {
    const out = await client6.executeCommand('nc -zv fd00::1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('tcpdump on the server captures BOTH the IPv4 handshake and the IPv6 handshake', async () => {
    await client4.executeCommand('nc -zv 192.168.1.1 22');
    await client6.executeCommand('nc -zv fd00::1 22');
    const cap = await server.executeCommand('tcpdump -n -c 100 port 22');
    expect(cap).toMatch(/192\.168\.1\.2\..*192\.168\.1\.1\.22/);
    expect(cap).toMatch(/fd00::2\..*fd00::1\.22/);
  });

  it('iptables blocking TCP 22 on IPv4 does NOT block IPv6 access (security gap by design)', async () => {
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');

    const v4 = await client4.executeCommand('nc -zv -w 1 192.168.1.1 22');
    expect(v4).toMatch(/refused|closed|timed out|no route/i);

    const v6 = await client6.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(v6).toMatch(/succeeded|open|Connected/i);
  });

  it('ip6tables blocking TCP 22 on IPv6 does NOT block IPv4 access (symmetric gap)', async () => {
    await server.executeCommand('ip6tables -A INPUT -p tcp --dport 22 -j DROP');

    const v6 = await client6.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(v6).toMatch(/refused|closed|timed out|no route/i);

    const v4 = await client4.executeCommand('nc -zv -w 1 192.168.1.1 22');
    expect(v4).toMatch(/succeeded|open|Connected/i);
  });

  it('sshd process appears attached to BOTH sockets in ss -tlnp', async () => {
    const out = await server.executeCommand('ss -tlnp');
    const sshdLines = out.split('\n').filter((l) => l.includes('sshd') && /LISTEN/.test(l));
    const hasV4 = sshdLines.some((l) => /0\.0\.0\.0:22/.test(l));
    const hasV6 = sshdLines.some((l) => /\[::\]:22/.test(l));
    expect(hasV4).toBe(true);
    expect(hasV6).toBe(true);
  });
});
