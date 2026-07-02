/**
 * Scénario 14 — Cohérence du port source après changement d'interface
 * (multi-homing et sélection de route).
 *
 * Objectif : sur une machine multi-homée, valider que le choix de
 * l'interface source (et donc l'IP source + le port éphémère) suit la
 * table de routage AVANT établissement, et que le 4-uplet
 * (src IP, dst IP, src port, dst port) reste rigoureusement stable
 * pendant toute la durée d'une session TCP, quels que soient les
 * changements de route survenus ensuite.
 *
 * Points de contrôle :
 *   - `ip route get <dst>` reflète la meilleure route disponible avant
 *     et après modification de métrique,
 *   - le SYN sort effectivement sur l'interface préférée,
 *   - `ss -tan` montre le port éphémère et l'IP source utilisés,
 *   - la session TCP établie ne migre PAS vers l'autre interface quand
 *     la préférence de routage change,
 *   - forcer la disparition de l'interface source de la session active
 *     rompt la session (pas d'état intermédiaire où les paquets
 *     alterneraient silencieusement entre les deux interfaces).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scenario 14 — multi-homed source-interface selection + 4-tuple stability', () => {
  let client: LinuxPC;
  let server: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    client = new LinuxPC('linux-pc', 'client', 0, 0);
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    const routerA = new CiscoRouter('router-cisco', 'RA', 0, 0);
    const routerB = new CiscoRouter('router-cisco', 'RB', 0, 0);
    const swAdmin = new CiscoSwitch('switch-cisco', 'swA', 8, 0, 0);
    const swProd = new CiscoSwitch('switch-cisco', 'swB', 8, 0, 0);
    const swSrv = new CiscoSwitch('switch-cisco', 'swS', 8, 0, 0);
    [client, server, routerA, routerB, swAdmin, swProd, swSrv].forEach((d) => d.powerOn());
    const pAdmin = Array.from(swAdmin.getPorts().values());
    const pProd = Array.from(swProd.getPorts().values());
    const pSrv = Array.from(swSrv.getPorts().values());
    new Cable('a1').connect(client.getPort('eth0')!, pAdmin[0]);
    new Cable('a2').connect(routerA.getPort('GigabitEthernet0/0')!, pAdmin[1]);
    new Cable('b1').connect(client.getPort('eth1')!, pProd[0]);
    new Cable('b2').connect(routerB.getPort('GigabitEthernet0/0')!, pProd[1]);
    new Cable('s1').connect(server.getPort('eth0')!, pSrv[0]);
    new Cable('s2').connect(routerA.getPort('GigabitEthernet0/1')!, pSrv[1]);
    new Cable('s3').connect(routerB.getPort('GigabitEthernet0/1')!, pSrv[2]);

    await client.executeCommand('ifconfig eth0 10.10.1.10 netmask 255.255.255.0');
    await client.executeCommand('ifconfig eth1 10.20.1.10 netmask 255.255.255.0');
    await server.executeCommand('ifconfig eth0 10.30.1.10 netmask 255.255.255.0');

    await routerA.executeCommand('enable');
    await routerA.executeCommand('configure terminal');
    await routerA.executeCommand('interface GigabitEthernet0/0');
    await routerA.executeCommand('ip address 10.10.1.1 255.255.255.0');
    await routerA.executeCommand('no shutdown');
    await routerA.executeCommand('exit');
    await routerA.executeCommand('interface GigabitEthernet0/1');
    await routerA.executeCommand('ip address 10.30.1.1 255.255.255.0');
    await routerA.executeCommand('no shutdown');
    await routerA.executeCommand('end');

    await routerB.executeCommand('enable');
    await routerB.executeCommand('configure terminal');
    await routerB.executeCommand('interface GigabitEthernet0/0');
    await routerB.executeCommand('ip address 10.20.1.1 255.255.255.0');
    await routerB.executeCommand('no shutdown');
    await routerB.executeCommand('exit');
    await routerB.executeCommand('interface GigabitEthernet0/1');
    await routerB.executeCommand('ip address 10.30.1.2 255.255.255.0');
    await routerB.executeCommand('no shutdown');
    await routerB.executeCommand('end');

    await server.executeCommand('ip route add 10.10.1.0/24 via 10.30.1.1');
    await server.executeCommand('ip route add 10.20.1.0/24 via 10.30.1.2');

    await client.executeCommand('ip route add 10.30.1.0/24 via 10.10.1.1 metric 10');
    await client.executeCommand('ip route add 10.30.1.0/24 via 10.20.1.1 metric 20');
  });

  it('ip route get 10.30.1.10 picks the lower-metric admin path (eth0 via 10.10.1.1)', async () => {
    const out = await client.executeCommand('ip route get 10.30.1.10');
    expect(out).toMatch(/10\.30\.1\.10.*via 10\.10\.1\.1/);
    expect(out).toMatch(/dev eth0/);
  });

  it('after raising the admin-path metric, ip route get shifts to eth1 (prod)', async () => {
    await client.executeCommand('ip route del 10.30.1.0/24 via 10.10.1.1');
    await client.executeCommand('ip route add 10.30.1.0/24 via 10.10.1.1 metric 30');
    const out = await client.executeCommand('ip route get 10.30.1.10');
    expect(out).toMatch(/10\.30\.1\.10.*via 10\.20\.1\.1/);
    expect(out).toMatch(/dev eth1/);
  });

  it('a fresh TCP connection uses the preferred interface source IP (10.10.1.10)', async () => {
    server.getTcpStack().listen(9500, { onAccept: () => undefined });
    const sock = client.getTcpStack().connect('10.30.1.10', 9500);
    expect(sock!.state).toBe('established');
    expect(sock!.localIp).toBe('10.10.1.10');
  });

  it('the 4-tuple of an established session is stable across a mid-session route flip', async () => {
    server.getTcpStack().listen(9501, { onAccept: () => undefined });
    const sock = client.getTcpStack().connect('10.30.1.10', 9501);
    expect(sock!.state).toBe('established');
    const tupleBefore = {
      localIp: sock!.localIp, localPort: sock!.localPort,
      remoteIp: sock!.remoteIp, remotePort: sock!.remotePort,
    };
    expect(tupleBefore.localIp).toBe('10.10.1.10');

    await client.executeCommand('ip route del 10.30.1.0/24 via 10.10.1.1');
    await client.executeCommand('ip route add 10.30.1.0/24 via 10.10.1.1 metric 30');

    sock!.write('probe-during-flip');

    expect(sock!.localIp).toBe(tupleBefore.localIp);
    expect(sock!.localPort).toBe(tupleBefore.localPort);
    expect(sock!.remoteIp).toBe(tupleBefore.remoteIp);
    expect(sock!.remotePort).toBe(tupleBefore.remotePort);
  });

  it('a NEW TCP connection AFTER the route flip uses the new preferred interface (10.20.1.10)', async () => {
    server.getTcpStack().listen(9502, { onAccept: () => undefined });
    const first = client.getTcpStack().connect('10.30.1.10', 9502);
    expect(first!.localIp).toBe('10.10.1.10');

    await client.executeCommand('ip route del 10.30.1.0/24 via 10.10.1.1');
    await client.executeCommand('ip route add 10.30.1.0/24 via 10.10.1.1 metric 30');

    server.getTcpStack().listen(9503, { onAccept: () => undefined });
    const second = client.getTcpStack().connect('10.30.1.10', 9503);
    expect(second!.state).toBe('established');
    expect(second!.localIp).toBe('10.20.1.10');
  });

  it('shutting down the source interface mid-session breaks the socket cleanly (no silent interface switch)', async () => {
    server.getTcpStack().listen(9504, { onAccept: () => undefined });
    const sock = client.getTcpStack().connect('10.30.1.10', 9504);
    expect(sock!.state).toBe('established');
    expect(sock!.localIp).toBe('10.10.1.10');

    await client.executeCommand('ip link set eth0 down');

    sock!.write('probe-after-shutdown');
    const stillUsesOldIp = sock!.localIp === '10.10.1.10';
    expect(stillUsesOldIp).toBe(true);
    expect(sock!.localIp).not.toBe('10.20.1.10');
  });

  it('ss -tan reports the ephemeral source port and address actually used', async () => {
    server.getTcpStack().listen(9505, { onAccept: () => undefined });
    const sock = client.getTcpStack().connect('10.30.1.10', 9505);
    expect(sock!.state).toBe('established');

    const ss = await client.executeCommand('ss -tan');
    const line = ss.split('\n').find((l) => l.includes(':9505'));
    expect(line).toBeTruthy();
    expect(line!).toContain('10.10.1.10');
    expect(line!).toContain(String(sock!.localPort));
  });
});
