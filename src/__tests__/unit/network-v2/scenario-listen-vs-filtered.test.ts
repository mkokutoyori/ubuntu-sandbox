import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface FlatLab {
  client: LinuxPC;
  server: LinuxServer;
  sw: GenericSwitch;
}

interface RoutedLab {
  clientRemote: LinuxPC;
  server: LinuxServer;
  gw: CiscoRouter;
  lanSw: GenericSwitch;
  wanSw: GenericSwitch;
}

async function buildFlat(): Promise<FlatLab> {
  const sw = new GenericSwitch('switch', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  const m = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), m);
  installListener(server, 8080);
  return { client, server, sw };
}

async function buildRouted(): Promise<RoutedLab> {
  const lanSw = new GenericSwitch('switch', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch', 'wan-sw', 8, 0, 0);
  const gw = new CiscoRouter('gw', 0, 0);
  const clientRemote = new LinuxPC('linux-pc', 'remote', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('a').connect(clientRemote.getPorts()[0], wanSw.getPorts()[0]);
  new Cable('b').connect(wanSw.getPorts()[7], gw.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(gw.getPort('GigabitEthernet0/1')!, lanSw.getPorts()[7]);
  new Cable('d').connect(server.getPorts()[0], lanSw.getPorts()[0]);
  const m = new SubnetMask('255.255.255.0');
  clientRemote.getPorts()[0].configureIP(new IPAddress('192.168.1.10'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), m);
  clientRemote.setDefaultGateway(new IPAddress('192.168.1.1'));
  server.setDefaultGateway(new IPAddress('10.0.0.1'));
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]) await gw.executeCommand(cmd);
  installListener(server, 8080);
  return { clientRemote, server, gw, lanSw, wanSw };
}

function installListener(server: LinuxServer, port: number): void {
  server.getTcpStack().listen(port, { onAccept: () => undefined });
  const st = (server as unknown as { executor: { socketTable: { bind: (p: 'tcp', a: string, port: number, pid?: number, name?: string) => unknown } } }).executor.socketTable;
  st.bind('tcp', '0.0.0.0', port, 4242, 'myapp');
}

async function baseFirewall(server: LinuxServer): Promise<void> {
  await server.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
  await server.executeCommand('iptables -A INPUT -s 127.0.0.0/8 -j ACCEPT');
}

describe('Scénario 2 — LISTEN local vs filtré côté réseau', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('ss -tlnp montre bien le port 8080 en LISTEN sur le serveur', async () => {
    const { server } = await buildFlat();
    const out = await server.executeCommand('ss -tlnp');
    expect(out).toMatch(/LISTEN/);
    expect(out).toMatch(/:8080/);
    expect(out).toMatch(/myapp/);
  });

  it('nc -zv depuis le serveur lui-même (localhost) réussit — vue applicative', async () => {
    const { server } = await buildFlat();
    await baseFirewall(server);
    const out = await server.executeCommand('nc -zv 127.0.0.1 8080');
    expect(out).toMatch(/succeeded|open/i);
  });

  it('nc -zv depuis un autre poste du LAN réussit tant qu\'aucune règle ne bloque', async () => {
    const { client } = await buildFlat();
    const out = await client.executeCommand('nc -zv 10.0.0.20 8080');
    expect(out).toMatch(/succeeded|open/i);
  });

  it('iptables -j DROP côté hôte: le port reste LISTEN local mais apparaît filtered depuis le LAN (timeout)', async () => {
    const { client, server } = await buildFlat();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j DROP');
    const local = await server.executeCommand('ss -tlnp');
    expect(local).toMatch(/:8080/);
    const remote = await client.executeCommand('nc -zv 10.0.0.20 8080');
    expect(remote).toMatch(/timed out|filtered/i);
    expect(remote).not.toMatch(/succeeded|open/i);
    expect(remote).not.toMatch(/refused/i);
  });

  it('iptables -j REJECT côté hôte: port toujours LISTEN local, mais apparaît closed depuis le LAN (refused)', async () => {
    const { client, server } = await buildFlat();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j REJECT');
    const remote = await client.executeCommand('nc -zv 10.0.0.20 8080');
    expect(remote).toMatch(/refused|closed/i);
    expect(remote).not.toMatch(/timed out/i);
  });

  it('avec iptables DROP: la vue locale (127.0.0.1) reste ouverte grâce à la règle standard -i lo -j ACCEPT', async () => {
    const { server } = await buildFlat();
    await baseFirewall(server);
    await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j DROP');
    const localhost = await server.executeCommand('nc -zv 127.0.0.1 8080');
    expect(localhost).toMatch(/succeeded|open/i);
    const ss = await server.executeCommand('ss -tlnp');
    expect(ss).toMatch(/:8080/);
  });

  it('ACL routeur en amont: LISTEN toujours actif, mais le poste distant voit un timeout (drop silencieux)', async () => {
    const { clientRemote, server, gw } = await buildRouted();
    for (const cmd of [
      'enable', 'configure terminal',
      'access-list 110 deny tcp any host 10.0.0.20 eq 8080',
      'access-list 110 permit ip any any',
      'interface GigabitEthernet0/1', 'ip access-group 110 out', 'end',
    ]) await gw.executeCommand(cmd);
    const local = await server.executeCommand('ss -tlnp');
    expect(local).toMatch(/:8080/);
    const remote = await clientRemote.executeCommand('nc -zv 10.0.0.20 8080');
    expect(remote).toMatch(/timed out/i);
    expect(remote).not.toMatch(/refused/i);
    expect(remote).not.toMatch(/succeeded|open/i);
  });

  it('divergence documentée: local=LISTEN, iptables DROP → deux vérités observables selon le point de mesure', async () => {
    const { client, server } = await buildFlat();
    await baseFirewall(server);
    await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j DROP');
    const svTable = await server.executeCommand('ss -tlnp');
    const svProbe = await server.executeCommand('nc -zv 127.0.0.1 8080');
    const remoteProbe = await client.executeCommand('nc -zv 10.0.0.20 8080');
    expect(svTable).toMatch(/:8080/);
    expect(svProbe).toMatch(/succeeded|open/i);
    expect(remoteProbe).toMatch(/timed out|filtered/i);
  });
});
