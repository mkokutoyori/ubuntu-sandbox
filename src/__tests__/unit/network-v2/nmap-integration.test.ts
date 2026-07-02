import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ListenerControl } from '@/database/oracle/listener/ListenerControl';
import { OracleListenerNetworkBinding } from '@/database/oracle/listener/OracleListenerNetworkBinding';

const ATTACKER_IP = '192.168.50.20';
const SERVER_IP = '192.168.50.10';

async function buildLab() {
  const sw = new GenericSwitch('SW');
  const server = new LinuxServer('linux-server', 'SRV');
  const attacker = new LinuxPC('linux-pc', 'ATTACKER');
  new Cable('c-srv').connect(server.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c-atk').connect(attacker.getPort('eth0')!, sw.getPort('eth2')!);
  await server.executeCommand(`sudo ip addr add ${SERVER_IP}/24 dev eth0`);
  await attacker.executeCommand(`sudo ip addr add ${ATTACKER_IP}/24 dev eth0`);
  await server.executeCommand('sudo ip link set eth0 up');
  await attacker.executeCommand('sudo ip link set eth0 up');
  return { sw, server, attacker };
}

function startListener(server: LinuxServer, opts?: { noBanner?: boolean }) {
  const listener = new ListenerControl({ sid: () => 'ORCL', instanceState: () => 'OPEN' });
  listener.start();
  if (opts?.noBanner) listener.setNoBannerMode(true);
  const binding = new OracleListenerNetworkBinding({
    host: server as unknown as ConstructorParameters<typeof OracleListenerNetworkBinding>[0]['host'],
    listener,
  });
  binding.attach();
  return { listener, binding };
}

describe('nmap — intégration sur topologie réelle', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('identifie un port réellement à l\'écoute comme open via le handshake TCP réel', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    const out = await lab.attacker.executeCommand(`nmap -p 1521 ${SERVER_IP}`);
    expect(out).toMatch(/1521\/tcp\s+open/);
    expect(out).toContain(`Nmap scan report for ${SERVER_IP}`);
    expect(out).toMatch(/Nmap done: 1 IP address \(1 host up\)/);
  });

  it('distingue un port fermé d\'un port ouvert', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    const out = await lab.attacker.executeCommand(`nmap -p 1521,1522 ${SERVER_IP}`);
    expect(out).toMatch(/1521\/tcp\s+open/);
    expect(out).not.toMatch(/1522\/tcp\s+open/);
    expect(out).toMatch(/1522\/tcp\s+(closed|filtered)/);
  });

  it('-sV lit la bannière réelle du service (SocketTable), pas un stub', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    const out = await lab.attacker.executeCommand(`nmap -sV -p 1521 ${SERVER_IP}`);
    expect(out).toMatch(/1521\/tcp\s+open\s+oracle-tns/);
  });

  it('-sV en mode no-banner ne divulgue pas la version applicative', async () => {
    const lab = await buildLab();
    startListener(lab.server, { noBanner: true });
    const out = await lab.attacker.executeCommand(`nmap -sV -p 1521 ${SERVER_IP}`);
    expect(out).toMatch(/1521\/tcp\s+open/);
    expect(out).not.toMatch(/CONNECT_DATA|SERVICE_NAME|ORCL/);
  });

  it('--open ne montre que les ports ouverts', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    const out = await lab.attacker.executeCommand(`nmap --open -p 1520,1521,1522 ${SERVER_IP}`);
    expect(out).toMatch(/1521\/tcp\s+open/);
    expect(out).not.toMatch(/1520\/tcp/);
    expect(out).not.toMatch(/1522\/tcp/);
  });

  it('-Pn scanne un hôte inexistant sans découverte et rapporte filtered', async () => {
    const lab = await buildLab();
    const out = await lab.attacker.executeCommand(`nmap -Pn -p 1521 192.168.50.200`);
    expect(out).toMatch(/1521\/tcp\s+(filtered|closed)/);
  });

  it('-oN écrit le rapport dans le VFS', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    await lab.attacker.executeCommand(`nmap -oN /tmp/scan.txt -p 1521 ${SERVER_IP}`);
    const cat = await lab.attacker.executeCommand('cat /tmp/scan.txt');
    expect(cat).toMatch(/1521\/tcp\s+open/);
    expect(cat).toContain('Nmap scan report for');
  });

  it('-oG écrit un rapport greppable dans le VFS', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    await lab.attacker.executeCommand(`nmap -oG /tmp/scan.gnmap -p 1521 ${SERVER_IP}`);
    const cat = await lab.attacker.executeCommand('cat /tmp/scan.gnmap');
    expect(cat).toMatch(/Host: 192\.168\.50\.10.*Status: Up/);
    expect(cat).toMatch(/1521\/open\/tcp/);
  });

  it('rapporte un hôte éteint comme down', async () => {
    const lab = await buildLab();
    await lab.server.executeCommand('sudo ip link set eth0 down');
    const out = await lab.attacker.executeCommand(`nmap -p 1521 ${SERVER_IP}`);
    expect(out).toMatch(/host down|Host seems down/i);
  });

  it('scanne plusieurs cibles en un appel', async () => {
    const lab = await buildLab();
    startListener(lab.server);
    const out = await lab.attacker.executeCommand(`nmap -p 1521 ${SERVER_IP} ${ATTACKER_IP}`);
    expect(out.match(/Nmap scan report for/g)?.length).toBe(2);
  });
});
