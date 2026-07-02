/**
 * Scénario 3 — Port fermé recevant du trafic malgré tout
 * (paquets orphelins / état résiduel)
 *
 * Objectif : valider le comportement de la pile TCP quand des paquets
 * arrivent pour une connexion dont le port n'est plus en écoute (service
 * redémarré, scan tardif).
 *
 * Déroulé :
 *   1. Établir une session TCP entre un client et un serveur (sshd:22).
 *   2. Tuer brutalement sshd côté serveur (kill -9, pas de FIN).
 *   3. Le client, qui croit la session encore active, envoie des données.
 *   4. Le serveur doit répondre par un RST parce que le socket local n'a
 *      plus de processus attaché — pas de "limbo".
 *
 * Points de contrôle :
 *   - `ss -tan` côté serveur ne montre plus la session ESTABLISHED,
 *   - `tcpdump` côté client capture bien le RST reçu du serveur,
 *   - l'écriture cliente rebascule l'état du socket local sur "closed" /
 *     "reset by peer".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scenario 3 — RST on packets to a port whose service was killed', () => {
  let client: LinuxPC;
  let server: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    client = new LinuxPC('linux-pc', 'client', 0, 0);
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    const sw = new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0);
    [client, server, sw].forEach((d) => d.powerOn());
    const p = Array.from(sw.getPorts().values());
    new Cable('c1').connect(client.getPort('eth0')!, p[0]);
    new Cable('c2').connect(server.getPort('eth0')!, p[1]);
    await client.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await server.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  });

  it('after systemctl stop ssh, no LISTEN socket remains on port 22 (kill -9 auto-restarts under systemd)', async () => {
    const beforeListens = (await server.executeCommand('ss -tlnp'))
      .split('\n').filter((l) => /LISTEN/.test(l) && /0\.0\.0\.0:22\b/.test(l));
    expect(beforeListens.length).toBeGreaterThan(0);

    await server.executeCommand('systemctl stop ssh');

    const afterListens = (await server.executeCommand('ss -tlnp'))
      .split('\n').filter((l) => /LISTEN/.test(l) && /:22\b/.test(l));
    expect(afterListens.length).toBe(0);
  });

  it('client TCP connection stays ESTABLISHED until packets flow — after kill+write, server RSTs and client socket transitions to closed', async () => {
    const serverStack = server.getTcpStack();
    const clientStack = client.getTcpStack();
    serverStack.listen(7000, { onAccept: () => undefined });
    const clientSocket = clientStack.connect('10.0.0.2', 7000);
    expect(clientSocket).toBeTruthy();
    expect(clientSocket!.state).toBe('established');

    serverStack.closeListener(7000);
    const anyStack = serverStack as unknown as { sockets: Map<string, { state: string }> };
    for (const s of Array.from(anyStack.sockets.values())) s.state = 'closed';
    anyStack.sockets.clear();

    clientSocket!.write('hello');
    expect(clientSocket!.state === 'closed' || clientSocket!.state === 'time-wait').toBe(true);
  });

  it('tcpdump on the client captures the incoming RST from the server after the kill', async () => {
    const serverStack = server.getTcpStack();
    const clientStack = client.getTcpStack();
    serverStack.listen(7001, { onAccept: () => undefined });
    const clientSocket = clientStack.connect('10.0.0.2', 7001);
    expect(clientSocket!.state).toBe('established');

    serverStack.closeListener(7001);
    const anyStack = serverStack as unknown as { sockets: Map<string, unknown> };
    anyStack.sockets.clear();

    clientSocket!.write('data');
    const cap = await client.executeCommand('tcpdump -n -c 30 port 7001');
    expect(cap).toMatch(/10\.0\.0\.2\.7001 > 10\.0\.0\.1\.\d+: Flags \[R/);
  });

  it('no half-closed limbo: after RST, the client socket is not still in ESTABLISHED', async () => {
    const serverStack = server.getTcpStack();
    const clientStack = client.getTcpStack();
    serverStack.listen(7002, { onAccept: () => undefined });
    const clientSocket = clientStack.connect('10.0.0.2', 7002);

    serverStack.closeListener(7002);
    const anyStack = serverStack as unknown as { sockets: Map<string, unknown> };
    anyStack.sockets.clear();

    clientSocket!.write('probe');
    expect(clientSocket!.state).not.toBe('established');
    expect(clientSocket!.state).not.toBe('syn-sent');
    expect(clientSocket!.state).not.toBe('syn-received');
  });
});
