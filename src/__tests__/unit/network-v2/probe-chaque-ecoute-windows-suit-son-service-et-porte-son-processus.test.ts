/**
 * Une ecoute ou une socket UDP de role ou de systeme Windows appartient au processus qui la sert et ne vit que tant que
 * son service tourne : DNS, DHCP (4, 6 et bascule), NPS, IIS, le coeur du cluster, l'Autodiscover et les connecteurs de
 * reception d'Exchange, LLMNR, mDNS, NTP et le port proxy ; et un processus qui meurt emporte aussi ses sockets UDP, sous
 * Linux comme sous Windows.
 *
 * Mesure de depart (2d36ab993), un LinuxPC et un WindowsServer cables, les roles DNS, DHCP, NPS et IIS installes :
 * `netstat -ano` listait UDP et TCP 53, UDP 67 et 547, UDP 1812 et 1813 et TCP 80 au PID 0 (le TCP 53 sous l'etiquette
 * `dnsmasq`, un demon Linux), TCP 647 au PID 1220 que `tasklist` ne connaissait pas, UDP 5353, 5355 et 123 (LLMNR, mDNS,
 * NTP) au PID 0, et une regle `netsh interface portproxy` au PID 1100, celui d'un svchost etranger (SamSs, CryptSvc),
 * alors que le service qui porte le port proxy, `iphlpsvc`, n'existait pas. `sc stop DNS` (comme DHCPServer, IAS et
 * W3SVC) laissait les ports ouverts : `nc -zvu 10.0.0.7 53` et `nc -zv 10.0.0.7 80` reussissaient avec le service
 * arrete. `taskkill /F` de `dns.exe` ne retirait rien (les lignes 53 n'avaient pas de PID a faucher). Et le faucheur de
 * prises, copie conforme d'un systeme a l'autre, ne retirait d'une prise UDP que sa ligne : sous Linux, `kill -9` de
 * `named` fait disparaitre la ligne de `ss -ulnp` et `dig` obtient sa reponse, l'ecoute UDP de l'hote ayant survecu a
 * la table.
 *
 * Autorites : `netstat -ano` donne le PID du processus qui tient la prise (Microsoft Learn, `netstat -o`) ; HTTP.sys
 * est le noyau, PID 4, pour tout site qu'il sert (Microsoft Q&A, deja cite pour WinRM et WSUS) ; le port proxy est porte
 * par le service IP Helper, `svchost.exe -k NetSvcs`, et ne tourne que si ce service tourne (SANS ISC, diary 27934 ;
 * Microsoft Q&A, « netsh interface portproxy doesn't work »). Non confirme depuis cet environnement : le proprietaire de
 * l'UDP 3343 du cluster (le pilote noyau NetFT d'apres une source tierce, donc System ; la documentation Microsoft ne
 * donne que le numero de port).
 *
 * Ce qui est construit : `WindowsServicePortProjection` tient des points d'acces (`WindowsEndpoint` : `open(identite)` et
 * `close()`) en plus des ecoutes TCP, rapproches de l'etat a chaque evenement de service avec l'isolation des echecs (un
 * point qui ne peut pas s'ouvrir ne garde pas les autres fermes, et l'echec remonte) ; DNS, DHCP (4, 6, bascule), NPS,
 * IIS (System), le coeur du cluster (System), l'Autodiscover (System) et les connecteurs de reception d'Exchange (le
 * service de transport), LLMNR et mDNS (Dnscache), NTP (W32Time) et les regles de port proxy (iphlpsvc, nouvelle
 * `PortProxyEndpoint` qui remplace la projection qui posait a la main une ligne au PID 1100) s'y declarent avec un
 * proprietaire et un predicat ; les roles ne s'ouvrent plus a leur creation mais quand leur service tourne, et
 * `start(identite)` donne leur PID aux sockets ; l'etat Started/Stopped d'un site IIS reste celui de l'administrateur,
 * l'ecoute celui de W3SVC ; l'identite des ecoutes de bascule et de requete en bloc DHCP vient du role (le PID 1220 invente
 * disparait) ; les sockets que LLMNR et mDNS ouvrent pour interroger le lien appartiennent a Dnscache
 * (`EndHost.resolverIdentity()` remplace `resolverProcessName()`) ; les deux faucheurs de prises deviennent un seul,
 * `EndHost.reapProcessSockets`, qui ferme aussi l'ecoute UDP ; un serveur dont on remplace le bus (`setEventBus`
 * reconstruit la projection) declare de nouveau ses points d'acces de role, que le constructeur n'avait declares que
 * sur la projection d'origine.
 *
 * Ce qui n'est PAS construit : l'Autodiscover d'Exchange n'est pas lie a W3SVC (la simulation n'exige pas IIS pour
 * Exchange) ; la requete en bloc DHCP des hotes autres que Windows (Linux, routeur, commutateur, pare-feu) garde son
 * identite fixe 1067/dhcpd, et Windows n'a aucune commande qui l'active ; les sockets du client DHCP (UDP 68 et 546) ne
 * publient aucune ligne de la table.
 *
 * Discrimination (fichier copie sur 2d36ab993) : TRENTE-QUATRE cas sur trente-neuf tombent. Les cinq autres passent des
 * deux cotes : le temoin, trois non-regressions (un role dont le port est pris echoue bruyamment sans garder les autres
 * fermes ; la desinstallation ferme les points d'acces du role ; un serveur dont on remplace le bus garde ses regles de
 * port proxy, que le premier jet de ce lot perdait) et une non-regression du faucheur commun (`kill -9` de sshd ferme le
 * 22, `systemctl restart ssh` le rouvre). Mutations, toutes tuees : sans isolation des echecs 1, echec avale
 * 1, proprietaire paresseux faux 3, identite non transmise 22 ; identite du resolveur vide 3, PID du NTP perdu 4, NTP
 * sans son service 1, port proxy sans son service 2, evenements du port proxy ignores 2, repondeurs sans etat
 * d'alimentation 1, mDNS sans son service 1, mise hors tension ignoree 1 ; DNS sans son service 2, DHCP 1, NPS 1, IIS 3,
 * cluster 1, connecteurs 1 ; DNS au noyau 5, cluster a son service 1, IIS a son service 2, sans rapprochement apres
 * `New-Cluster` 2 et apres `New-ReceiveConnector` 1, Autodiscover a un service 1 ; DNS UDP sans PID 6, DNS TCP sans PID 4,
 * etiquette de demon Linux 1, DHCP UDP sans PID 3, DHCPv6 3, bascule 3, NPS 3, IIS sans identite 3, arret d'IIS qui oublie
 * l'etat des sites 2, site qui ecoute service arrete 1, cluster sans PID 2 ; connexion relayee du port proxy sans
 * proprietaire 1, regle retiree gardee 1, port proxy sans identite 2, fermeture sans effet 1 ; faucheur qui ne retire que
 * la ligne UDP 1, socket de requete du resolveur sans PID 3, demarrage HTTP non idempotent 1, demarrage SMTP non
 * idempotent 1, SMTP sans identite 3, faucheur Linux qui oublie les ports de sshd 1, iphlpsvc hors svchost 1 ; roles non
 * declares de nouveau quand le bus change 2 (et le scenario NPS 802.1X de windows-server-nps, qui remplace le bus de son
 * serveur), point d'acces du port proxy reconstruit a chaque cablage 1.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  resetExchangeOrganizations();
});

type Protocol = 'TCP' | 'UDP';
type Endpoint = readonly [Protocol, number];

interface Lab {
  readonly linux: LinuxPC;
  readonly windows: WindowsServer;
  tcp(port: number): Promise<'open' | 'refused'>;
  udp(port: number): Promise<'answers' | 'unreachable'>;
  reach(endpoint: Endpoint): Promise<'reachable' | 'unreachable'>;
}

async function lab(): Promise<Lab> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsServer('SRV', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  const tcp: Lab['tcp'] = async (port) => {
    let opened = false;
    const socket = linux.getTcpStack().connect('10.0.0.7', port, { onOpen: () => { opened = true; } })!;
    await settle();
    if (opened) socket.close();
    return opened ? 'open' : 'refused';
  };
  const udp: Lab['udp'] = async (port) =>
    (await linux.executeCommand(`nc -zvu -w 1 10.0.0.7 ${port}`)).includes('succeeded') ? 'answers' : 'unreachable';
  return {
    linux, windows, tcp, udp,
    reach: async ([protocol, port]) =>
      (protocol === 'TCP' ? await tcp(port) === 'open' : await udp(port) === 'answers') ? 'reachable' : 'unreachable',
  };
}

const powershell = (windows: WindowsServer, command: string) => windows.executeCommand(`powershell -Command "${command}"`);
const run = async (windows: WindowsServer, line: string) => (await PowerShellSubShell.create(windows).subShell.processLine(line)).output.join('\n');

async function rowPid(windows: WindowsServer, [protocol, port]: Endpoint): Promise<number | null> {
  const pattern = protocol === 'TCP'
    ? new RegExp(`^\\s*TCP\\s+0\\.0\\.0\\.0:${port}\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+(\\d+)\\s*$`)
    : new RegExp(`^\\s*UDP\\s+0\\.0\\.0\\.0:${port}\\s+\\*:\\*\\s+(\\d+)\\s*$`);
  for (const line of (await windows.executeCommand('netstat -ano')).split('\n')) {
    const match = pattern.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

async function servicePid(windows: WindowsServer, service: string): Promise<number> {
  return Number(/PID\s*:\s*(\d+)/.exec(await windows.executeCommand(`sc queryex ${service}`))![1]);
}

async function imageOf(windows: WindowsServer, pid: number): Promise<string> {
  const row = (await windows.executeCommand(`tasklist /FI "PID eq ${pid}"`)).split('\n').find((line) => new RegExp(`\\s${pid}\\s`).test(line));
  return row ? row.trim().split(/\s+/)[0] : '<absent>';
}

async function ownerlessRows(windows: WindowsServer): Promise<string[]> {
  const known = new Set((await windows.executeCommand('tasklist')).split('\n').slice(3).map((line) => line.trim().split(/\s+/)[1]));
  return (await windows.executeCommand('netstat -ano')).split('\n')
    .filter((line) => /^\s*TCP\s.*\sLISTENING\s/.test(line) || /^\s*UDP\s/.test(line))
    .filter((line) => {
      const pid = line.trim().split(/\s+/).pop()!;
      return pid === '0' || !known.has(pid);
    });
}

interface RoleCase {
  readonly feature: string;
  readonly service: string;
  readonly endpoints: readonly Endpoint[];
}

const ROLES: readonly RoleCase[] = [
  { feature: 'DNS', service: 'DNS', endpoints: [['TCP', 53], ['UDP', 53]] },
  { feature: 'DHCP', service: 'DHCPServer', endpoints: [['UDP', 67], ['UDP', 547], ['TCP', 647]] },
  { feature: 'NPAS', service: 'IAS', endpoints: [['UDP', 1812], ['UDP', 1813]] },
  { feature: 'Web-Server', service: 'W3SVC', endpoints: [['TCP', 80]] },
];

async function reachAll(lab: Lab, endpoints: readonly Endpoint[]): Promise<Array<'reachable' | 'unreachable'>> {
  const out: Array<'reachable' | 'unreachable'> = [];
  for (const endpoint of endpoints) out.push(await lab.reach(endpoint));
  return out;
}

describe('the bench is sound (witness)', () => {
  it('sshd listens at the pid of sshd.exe, and an installed DNS role answers on UDP and TCP 53', async () => {
    const bench = await lab();
    expect(await rowPid(bench.windows, ['TCP', 22])).toBe(1088);
    await powershell(bench.windows, 'Install-WindowsFeature DNS');
    expect(await bench.udp(53)).toBe('answers');
    expect(await bench.tcp(53)).toBe('open');
  });
});

describe('a role listener carries the process of its service', () => {
  it.each(ROLES.slice(0, 3).map((role) => [role.feature, role.service, role.endpoints] as const))(
    '%s: every endpoint of %s is held by the process hosting the service', async (feature, service, endpoints) => {
      const { windows } = await lab();
      await powershell(windows, `Install-WindowsFeature ${feature}`);
      const host = await servicePid(windows, service);
      expect(host).not.toBe(0);
      for (const endpoint of endpoints) expect(await rowPid(windows, endpoint)).toBe(host);
      expect(await windows.executeCommand(`tasklist /svc /FI "PID eq ${host}"`)).toContain(service);
    });

  it('the DNS role rows are labelled with the image of the process, not with a Linux daemon', async () => {
    const { windows } = await lab();
    await powershell(windows, 'Install-WindowsFeature DNS');
    const rows = windows.getSocketTable().getAll().filter((row) => row.localPort === 53);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.processName).toBe('dns.exe');
  });

  it('Web-Server: TCP 80 belongs to the kernel (HTTP.sys, System, pid 4) while W3SVC runs', async () => {
    const { windows } = await lab();
    await powershell(windows, 'Install-WindowsFeature Web-Server');
    expect(await rowPid(windows, ['TCP', 80])).toBe(4);
  });

  it('NTP, LLMNR and mDNS belong to the svchost hosting W32Time and Dnscache', async () => {
    const { windows } = await lab();
    expect(await rowPid(windows, ['UDP', 123])).toBe(await servicePid(windows, 'W32Time'));
    expect(await rowPid(windows, ['UDP', 5355])).toBe(await servicePid(windows, 'Dnscache'));
    expect(await rowPid(windows, ['UDP', 5353])).toBe(await servicePid(windows, 'Dnscache'));
  });

  it('the resolver sockets that query the link belong to the DNS client too', async () => {
    const { windows } = await lab();
    const dnscache = await servicePid(windows, 'Dnscache');
    const udpRows = (await windows.executeCommand('netstat -ano')).split('\n').filter((line) => /^\s*UDP\s/.test(line));
    expect(udpRows.length).toBeGreaterThan(2);
    for (const row of udpRows.filter((line) => !/:123\s/.test(line))) expect(row.trim().split(/\s+/).pop()).toBe(String(dnscache));
  });

  it('a port proxy rule listens at the pid of the svchost hosting iphlpsvc, in one row, and its relayed connection is that process\'s too', async () => {
    const { linux, windows } = await lab();
    linux.getTcpStack().listen(80, { onAccept: () => undefined });
    await windows.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    const rows = (await windows.executeCommand('netstat -ano')).split('\n').filter((line) => /:8080\s/.test(line));
    expect(rows).toHaveLength(1);
    const host = await servicePid(windows, 'iphlpsvc');
    expect(await rowPid(windows, ['TCP', 8080])).toBe(host);
    const client = linux.getTcpStack().connect('10.0.0.7', 8080, {})!;
    await settle();
    const relayed = (await windows.executeCommand('netstat -ano')).split('\n').filter((line) => /10\.0\.0\.3:80\s+ESTABLISHED/.test(line));
    expect(relayed).toHaveLength(1);
    expect(relayed[0].trim().split(/\s+/).pop()).toBe(String(host));
    client.close();
  });

  it('a cluster node holds its heartbeat port at the kernel (System, pid 4)', async () => {
    const { windows } = await lab();
    await powershell(windows, 'Install-WindowsFeature Failover-Clustering');
    await run(windows, 'New-Cluster -Name CLUS1 -Node SRV,PEER -NodeAddress 10.0.0.7,10.0.0.9');
    expect(await rowPid(windows, ['UDP', 3343])).toBe(4);
  });

  it('Exchange: Autodiscover is held by HTTP.sys (pid 4) and a receive connector by the Transport service process, with no handler failing on the way', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { windows, tcp } = await exchangeLab();
    await windows.executeCommand('sc stop MSExchangeIS');
    await windows.executeCommand('sc start MSExchangeIS');
    expect(errors.mock.calls.filter(([message]) => String(message).includes('[EventBus] handler'))).toEqual([]);
    errors.mockRestore();
    expect(await rowPid(windows, ['TCP', 80])).toBe(4);
    const transport = await servicePid(windows, 'MSExchangeTransport');
    expect(transport).not.toBe(0);
    expect(await imageOf(windows, transport)).toBe('EdgeTransport.exe');
    expect(await rowPid(windows, ['TCP', 25])).toBe(transport);
    expect(await tcp(25)).toBe('open');
  });

  it('a loaded server leaves no listener or UDP socket without a process that tasklist knows', async () => {
    const { windows } = await lab();
    for (const feature of ['DNS', 'DHCP', 'NPAS', 'Web-Server', 'FS-DFS-Replication', 'UpdateServices', 'Print-Services', 'Failover-Clustering']) {
      await powershell(windows, `Install-WindowsFeature ${feature}`);
    }
    await run(windows, 'New-Cluster -Name CLUS1 -Node SRV,PEER -NodeAddress 10.0.0.7,10.0.0.9');
    await powershell(windows, 'Enable-RemoteDesktop');
    await windows.executeCommand('winrm quickconfig -q');
    await windows.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    const rows = (await windows.executeCommand('netstat -ano')).split('\n').filter((line) => /^\s*(TCP|UDP)\s/.test(line));
    expect(rows.length).toBeGreaterThan(20);
    expect(await ownerlessRows(windows)).toEqual([]);
  });

  it('a domain controller with Exchange leaves no ownerless listener either', async () => {
    const { windows } = await exchangeLab();
    await powershell(windows, 'Install-WindowsFeature DNS');
    const rows = (await windows.executeCommand('netstat -ano')).split('\n').filter((line) => /^\s*(TCP|UDP)\s/.test(line));
    expect(rows.length).toBeGreaterThan(15);
    expect(await ownerlessRows(windows)).toEqual([]);
  });
});

async function exchangeLab(): Promise<Lab> {
  const bench = await lab();
  await run(bench.windows, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(bench.windows, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(bench.windows, 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  await run(bench.windows, 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
  return bench;
}

describe('a role listener lives while its service runs', () => {
  it.each(ROLES.map((role) => [role.feature, role.service, role.endpoints] as const))(
    '%s: sc stop %s refuses every endpoint, sc start gives them back', async (feature, service, endpoints) => {
      const bench = await lab();
      await powershell(bench.windows, `Install-WindowsFeature ${feature}`);
      expect(await reachAll(bench, endpoints)).toEqual(endpoints.map(() => 'reachable'));
      await bench.windows.executeCommand(`sc stop ${service}`);
      expect(await reachAll(bench, endpoints)).toEqual(endpoints.map(() => 'unreachable'));
      for (const endpoint of endpoints) expect(await rowPid(bench.windows, endpoint)).toBeNull();
      await bench.windows.executeCommand(`sc start ${service}`);
      expect(await reachAll(bench, endpoints)).toEqual(endpoints.map(() => 'reachable'));
      const host = await servicePid(bench.windows, service);
      for (const endpoint of endpoints) expect(await rowPid(bench.windows, endpoint)).toBe(feature === 'Web-Server' ? 4 : host);
    });

  it.each([
    ['sc stop DNS'],
    ['net stop DNS'],
    ['powershell -Command "Stop-Service DNS"'],
  ])('%s: DNS stops answering on both transports', async (command) => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature DNS');
    await bench.windows.executeCommand(command);
    expect(await bench.udp(53)).toBe('unreachable');
    expect(await bench.tcp(53)).toBe('refused');
  });

  it('taskkill /F of dns.exe closes the UDP responder as well as the TCP listener, and a restart reopens both', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature DNS');
    const dns = await servicePid(bench.windows, 'DNS');
    await bench.windows.executeCommand(`taskkill /F /PID ${dns}`);
    expect(await bench.udp(53)).toBe('unreachable');
    expect(await bench.tcp(53)).toBe('refused');
    expect(await rowPid(bench.windows, ['UDP', 53])).toBeNull();
    await bench.windows.executeCommand('sc start DNS');
    const revived = await servicePid(bench.windows, 'DNS');
    expect(revived).not.toBe(dns);
    expect(await rowPid(bench.windows, ['UDP', 53])).toBe(revived);
    expect(await bench.udp(53)).toBe('answers');
    expect(await bench.tcp(53)).toBe('open');
  });

  it('the death of the svchost hosting DHCPServer closes its UDP and TCP endpoints', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature DHCP');
    await bench.windows.executeCommand(`taskkill /F /PID ${await servicePid(bench.windows, 'DHCPServer')}`);
    expect(await bench.udp(67)).toBe('unreachable');
    expect(await bench.tcp(647)).toBe('refused');
  });

  it('stopping Dnscache closes LLMNR and mDNS and leaves NTP alone; W32Time owns 123', async () => {
    const bench = await lab();
    await bench.windows.executeCommand('sc stop Dnscache');
    expect(await rowPid(bench.windows, ['UDP', 5355])).toBeNull();
    expect(await rowPid(bench.windows, ['UDP', 5353])).toBeNull();
    expect(await bench.udp(5355)).toBe('unreachable');
    expect(await rowPid(bench.windows, ['UDP', 123])).not.toBeNull();
    await bench.windows.executeCommand('sc stop W32Time');
    expect(await rowPid(bench.windows, ['UDP', 123])).toBeNull();
    expect(await bench.udp(123)).toBe('unreachable');
    await bench.windows.executeCommand('sc start W32Time');
    await bench.windows.executeCommand('sc start Dnscache');
    expect(await rowPid(bench.windows, ['UDP', 123])).toBe(await servicePid(bench.windows, 'W32Time'));
    expect(await rowPid(bench.windows, ['UDP', 5355])).toBe(await servicePid(bench.windows, 'Dnscache'));
  });

  it('killing the svchost hosting Dnscache closes 5353 and 5355, and the service comes back in a new svchost', async () => {
    const bench = await lab();
    const host = await servicePid(bench.windows, 'Dnscache');
    await bench.windows.executeCommand(`taskkill /F /PID ${host}`);
    expect(await rowPid(bench.windows, ['UDP', 5355])).toBeNull();
    expect(await bench.udp(5355)).toBe('unreachable');
    expect(await rowPid(bench.windows, ['UDP', 123])).not.toBeNull();
    await bench.windows.executeCommand('sc start Dnscache');
    const revived = await servicePid(bench.windows, 'Dnscache');
    expect(revived).not.toBe(0);
    expect(revived).not.toBe(host);
    expect(await rowPid(bench.windows, ['UDP', 5355])).toBe(revived);
  });

  it('stopping iphlpsvc closes the port proxy and keeps the rule; starting it opens the port again; deleting the rule closes it for good', async () => {
    const bench = await lab();
    await bench.windows.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    expect(await bench.tcp(8080)).toBe('open');
    await bench.windows.executeCommand('sc stop iphlpsvc');
    expect(await bench.tcp(8080)).toBe('refused');
    expect(await rowPid(bench.windows, ['TCP', 8080])).toBeNull();
    expect(await bench.windows.executeCommand('netsh interface portproxy show all')).toContain('8080');
    await bench.windows.executeCommand('sc start iphlpsvc');
    expect(await bench.tcp(8080)).toBe('open');
    await bench.windows.executeCommand('netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=0.0.0.0');
    expect(await bench.tcp(8080)).toBe('refused');
    await bench.windows.executeCommand('sc stop iphlpsvc');
    await bench.windows.executeCommand('sc start iphlpsvc');
    expect(await bench.tcp(8080)).toBe('refused');
  });

  it('a port proxy rule added while iphlpsvc is stopped listens only once the service starts', async () => {
    const bench = await lab();
    await bench.windows.executeCommand('sc stop iphlpsvc');
    await bench.windows.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    expect(await bench.tcp(8080)).toBe('refused');
    await bench.windows.executeCommand('sc start iphlpsvc');
    expect(await bench.tcp(8080)).toBe('open');
  });

  it('the state of an IIS site survives the W3SVC service: a site stopped by hand stays stopped after a restart', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature Web-Server');
    await run(bench.windows, 'New-Website -Name Extra -PhysicalPath C:\\inetpub\\extra -Port 8081');
    expect(await bench.tcp(8081)).toBe('open');
    await run(bench.windows, 'Stop-Website -Name Extra');
    expect(await bench.tcp(8081)).toBe('refused');
    await bench.windows.executeCommand('sc stop W3SVC');
    expect(await bench.tcp(80)).toBe('refused');
    await bench.windows.executeCommand('sc start W3SVC');
    expect(await bench.tcp(80)).toBe('open');
    expect(await bench.tcp(8081)).toBe('refused');
    await run(bench.windows, 'Start-Website -Name Extra');
    expect(await bench.tcp(8081)).toBe('open');
  });

  it('a site started while W3SVC is stopped listens only when the service starts', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature Web-Server');
    await run(bench.windows, 'New-Website -Name Extra -PhysicalPath C:\\inetpub\\extra -Port 8081');
    await bench.windows.executeCommand('sc stop W3SVC');
    expect(await bench.tcp(8081)).toBe('refused');
    await run(bench.windows, 'Stop-Website -Name Extra');
    await run(bench.windows, 'Start-Website -Name Extra');
    expect(await bench.tcp(8081)).toBe('refused');
    await bench.windows.executeCommand('sc start W3SVC');
    expect(await bench.tcp(8081)).toBe('open');
  });

  it('a role whose port is taken fails loudly and does not keep the other roles closed', async () => {
    const bench = await lab();
    bench.windows.getTcpStack().listen(53, { onAccept: () => undefined });
    await expect(powershell(bench.windows, 'Install-WindowsFeature DNS')).rejects.toThrow(/EADDRINUSE/);
    await powershell(bench.windows, 'Install-WindowsFeature DHCP').catch(() => undefined);
    expect(await bench.udp(67)).toBe('answers');
  });

  it('a powered-off server holds no responder socket, and power-on gives LLMNR, mDNS and NTP back', async () => {
    const bench = await lab();
    const responders = () => [...new Set(bench.windows.getSocketTable().getAll()
      .filter((row) => row.protocol === 'udp' && [5355, 5353, 123].includes(row.localPort)).map((row) => row.localPort))].sort();
    expect(responders()).toEqual([123, 5353, 5355]);
    bench.windows.powerOff();
    expect(responders()).toEqual([]);
    bench.windows.powerOn();
    expect(responders()).toEqual([123, 5353, 5355]);
  });

  it('Uninstall-WindowsFeature closes the endpoints the role held', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature DNS');
    await powershell(bench.windows, 'Uninstall-WindowsFeature DNS');
    expect(await bench.udp(53)).toBe('unreachable');
    expect(await bench.tcp(53)).toBe('refused');
  });

  it('a reboot gives the role endpoints back: Automatic services start again and their endpoints open', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature DNS');
    bench.windows.powerOff();
    bench.windows.powerOn();
    bench.windows.setCurrentUser('Administrator');
    expect(await bench.udp(53)).toBe('answers');
    expect(await bench.tcp(53)).toBe('open');
    expect(await rowPid(bench.windows, ['UDP', 53])).toBe(await servicePid(bench.windows, 'DNS'));
    expect(await rowPid(bench.windows, ['UDP', 5355])).toBe(await servicePid(bench.windows, 'Dnscache'));
  });

  it('stopping MSExchangeTransport closes the receive connector and starting it opens it again', async () => {
    const bench = await exchangeLab();
    expect(await bench.tcp(25)).toBe('open');
    await bench.windows.executeCommand('sc stop MSExchangeTransport');
    expect(await bench.tcp(25)).toBe('refused');
    await bench.windows.executeCommand('sc start MSExchangeTransport');
    expect(await bench.tcp(25)).toBe('open');
    expect(await rowPid(bench.windows, ['TCP', 25])).toBe(await servicePid(bench.windows, 'MSExchangeTransport'));
  });

  it('stopping ClusSvc closes the heartbeat port of a formed cluster and starting it opens it again', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature Failover-Clustering');
    await run(bench.windows, 'New-Cluster -Name CLUS1 -Node SRV,PEER -NodeAddress 10.0.0.7,10.0.0.9');
    expect(await bench.udp(3343)).toBe('answers');
    await bench.windows.executeCommand('sc stop ClusSvc');
    expect(await bench.udp(3343)).toBe('unreachable');
    await bench.windows.executeCommand('sc start ClusSvc');
    expect(await bench.udp(3343)).toBe('answers');
  });

  it('a server moved to another event bus before the role is installed opens the endpoints at install and closes them with the service', async () => {
    const bench = await lab();
    bench.windows.setEventBus(new EventBus());
    await powershell(bench.windows, 'Install-WindowsFeature NPAS');
    expect(await bench.udp(1812)).toBe('answers');
    expect(await rowPid(bench.windows, ['UDP', 1812])).toBe(await servicePid(bench.windows, 'IAS'));
    await bench.windows.executeCommand('sc stop IAS');
    expect(await bench.udp(1812)).toBe('unreachable');
    await bench.windows.executeCommand('sc start IAS');
    expect(await bench.udp(1812)).toBe('answers');
  });

  it('a server moved to another event bus after the role is installed still closes the endpoints with the service', async () => {
    const bench = await lab();
    await powershell(bench.windows, 'Install-WindowsFeature DNS');
    bench.windows.setEventBus(new EventBus());
    expect(await bench.udp(53)).toBe('answers');
    await bench.windows.executeCommand('sc stop DNS');
    expect(await bench.udp(53)).toBe('unreachable');
    expect(await bench.tcp(53)).toBe('refused');
    await bench.windows.executeCommand('sc start DNS');
    expect(await bench.udp(53)).toBe('answers');
    expect(await bench.tcp(53)).toBe('open');
  });

  it('a server moved to another event bus keeps the port proxy rules it listens for: deleting a rule still closes its port', async () => {
    const bench = await lab();
    await bench.windows.executeCommand('netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=80 connectaddress=10.0.0.3');
    expect(await bench.tcp(8080)).toBe('open');
    bench.windows.setEventBus(new EventBus());
    await bench.windows.executeCommand('netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=0.0.0.0');
    expect(await bench.tcp(8080)).toBe('refused');
    expect(await rowPid(bench.windows, ['TCP', 8080])).toBeNull();
  });
});

describe('a killed process takes its sockets with it on a Linux host too', () => {
  const NAMED_CONF = ['options {', '  directory "/var/cache/bind";', '  recursion no;', '};', 'zone "example.com" {', '  type primary;', '  file "/etc/bind/db.example";', '};', ''].join('\n');
  const ZONE_DB = ['$ORIGIN example.com.', '$TTL 3600', '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )', '    IN NS  ns1.example.com.', 'ns1 IN A   10.0.1.10', 'www IN A   10.0.1.80', ''].join('\n');

  let nextId = 1;
  const query = (): DnsMessage => ({
    id: nextId++,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'www.example.com', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  });

  it('kill -9 of named: the UDP responder stops answering, not only the ss row', async () => {
    const client = new LinuxPC('linux-pc', 'PC1');
    const server = new LinuxServer('linux-server', 'NS1');
    client.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    server.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c2').connect(client.getPort('eth0')!, server.getPort('eth0')!);
    const vfs = (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
    vfs.writeFile('/etc/bind/named.conf', NAMED_CONF, 0, 0, 0o022);
    vfs.writeFile('/etc/bind/db.example', ZONE_DB, 0, 0, 0o022);
    await server.executeCommand('sudo systemctl start named');
    const ask = async () => (await queryDnsOverUdp(client, new IPAddress('10.0.1.10'), query(), 53, 300)) !== null;
    expect(await ask()).toBe(true);
    const pid = (await server.executeCommand('pidof named')).trim();
    await server.executeCommand(`sudo kill -9 ${pid}`);
    expect(await server.executeCommand('sudo ss -ulnp')).not.toContain('named');
    expect(await ask()).toBe(false);
  });

  it('kill -9 of sshd closes port 22, and starting the service again opens it again', async () => {
    const client = new LinuxPC('linux-pc', 'PC1');
    const server = new LinuxServer('linux-server', 'SRV1');
    client.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    server.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c3').connect(client.getPort('eth0')!, server.getPort('eth0')!);
    const reaches = async (): Promise<boolean> => {
      let opened = false;
      const socket = client.getTcpStack().connect('10.0.1.10', 22, { onOpen: () => { opened = true; } })!;
      await settle();
      if (opened) socket.close();
      return opened;
    };
    expect(await reaches()).toBe(true);
    const pid = (await server.executeCommand('pidof sshd')).trim().split(/\s+/)[0];
    await server.executeCommand(`sudo kill -9 ${pid}`);
    expect(await reaches()).toBe(false);
    await server.executeCommand('sudo systemctl restart ssh');
    expect(await reaches()).toBe(true);
  });
});
