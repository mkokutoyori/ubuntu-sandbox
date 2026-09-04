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
  const sw = new GenericSwitch('switch-generic', 'SW');
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

/**
 * Démarre l'unité, et n'ouvre une écoute que si personne ne sert déjà ce
 * port. `apache2` en sert un pour de bon depuis
 * docs/PRD-Manquements.md §M4a (comme nginx avant lui), donc en poser une
 * seconde lève EADDRINUSE ; `mysql` n'a toujours aucun serveur derrière
 * lui et a encore besoin de celle-ci. Même correctif qu'aux scénarios
 * s05/s07 pour le 1521.
 */
async function startTcpService(server: LinuxServer, unit: string, port: number): Promise<void> {
  await server.executeCommand(`sudo systemctl start ${unit}`);
  const stack = (server as unknown as {
    getTcpStack(): {
      listen(p: number, h: { onAccept: () => void }): void;
      listListeners(): { localPort: number }[];
    };
  }).getTcpStack();
  if (stack.listListeners().some((l) => l.localPort === port)) return;
  stack.listen(port, { onAccept: () => undefined });
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

  // Ce cas encodait une premisse que le vrai `nmap` contredit : sur un
  // segment ethernet local, l'ARP est emis MEME sous `-Pn`, et un hote qui
  // n'y repond pas est declare `down` — donc aucune table de ports n'est
  // rendue. Le manuel : « Nmap normally does ARP or IPv6 Neighbor
  // Discovery (ND) discovery of locally connected ethernet hosts, even if
  // other host discovery options such as -Pn or -PE are used. » Ce que le
  // cas voulait eprouver — `-Pn` saute la decouverte IP — reste eprouve
  // par `--disable-arp-ping`, qui rend a l'option son sens litteral.
  it('-Pn ne dispense pas de l ARP sur le segment local', async () => {
    const lab = await buildLab();
    const out = await lab.attacker.executeCommand(`nmap -Pn -p 1521 192.168.50.200`);
    expect(out).toMatch(/Host seems down/);
  });

  it('--disable-arp-ping rend a -Pn son sens litteral', async () => {
    const lab = await buildLab();
    const out = await lab.attacker.executeCommand(
      'nmap -Pn --disable-arp-ping -p 1521 192.168.50.200');
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

  it('-sV identifie le service via le processus réel du daemon (apache2 → http)', async () => {
    const lab = await buildLab();
    await startTcpService(lab.server, 'apache2', 80);
    const out = await lab.attacker.executeCommand(`nmap -sV -p 80 ${SERVER_IP}`);
    expect(out).toMatch(/80\/tcp\s+open\s+http/);
  });

  it('-sV identifie une base de données réelle via son processus (mysqld → mysql)', async () => {
    const lab = await buildLab();
    await startTcpService(lab.server, 'mysql', 3306);
    const out = await lab.attacker.executeCommand(`nmap -sV -p 3306 ${SERVER_IP}`);
    expect(out).toMatch(/3306\/tcp\s+open\s+mysql/);
  });

  it('sans -sV le service est deviné par le port, sans fabriquer de version', async () => {
    const lab = await buildLab();
    await startTcpService(lab.server, 'apache2', 80);
    const out = await lab.attacker.executeCommand(`nmap -p 80 ${SERVER_IP}`);
    expect(out).toMatch(/80\/tcp\s+open\s+http/);
    expect(out).not.toMatch(/Apache/);
  });
});
