/**
 * Lab de l'utilisateur (`SSH_TP_LAN.topology (8).json`) : l'ACL 100 posee en entree de
 * GigabitEthernet0/0.99 sur MAIN_RT_AKWA (refus de SSH de PC7 192.168.10.4 vers WinServer3
 * 192.168.60.2, ICMP permis partout, UDP permis de PC7 vers WinServer3, les deux regles
 * « log »), puis `nmap -sU` de PC7 vers WinServer3. Question posee : le comportement du
 * simulateur est-il normal ?
 *
 * Mesure, sans aucun changement de code : les quinze cas passent. Ce sont donc des TEMOINS de
 * comportement, pas la fermeture d'un defaut. Le scenario tient en UN SEUL test : le Logger global est remis
 * a zero avant chaque test, ce qui couperait l'abonnement du routeur au journal et ferait mentir `show logging`. Ce qu'ils figent : l'ACL est acceptee dans l'ordre
 * de l'utilisateur (le groupe d'acces avant la liste), `nmap -sU` voit les memes etats avant et
 * apres (la regle UDP laisse passer, les « ICMP port unreachable » reviennent par .50 et ne
 * traversent pas l'ACL), la regle compte une sonde par port et journalise chaque flux au format
 * %SEC-6-IPACCESSLOGP, le refus SSH est compte, journalise et rendu a l'emetteur en ICMP
 * « administratively prohibited », un autre hote est refuse sans compteur (refus implicite), et
 * le refus implicite emporte aussi les Hello OSPF recus sur la sous-interface : au bout du
 * delai d'inactivite l'adjacence tombe, la route d'Akwa disparait et PC7 n'atteint plus
 * WinServer3, jusqu'a `permit ospf any any`.
 *
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installSimulationClock, getSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';

interface Shell {
  executeCommand(cmd: string): Promise<string>;
  executeCmdCommand(cmd: string): Promise<string>;
  getPorts(): Array<{ getName(): string }>;
}

const EXPORT = join(__dirname, '..', 'new_firewall', 'SSH_TP_LAN.topology (8).json');
const ROUTERS = ['MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO', 'MAIN_RT_AKWA'];

let machines: Map<string, Shell>;
const machine = (name: string): Shell => machines.get(name)!;
const akwa = (command: string) => machine('MAIN_RT_AKWA').executeCommand(command);
const pc7 = (command: string) => machine('PC7').executeCmdCommand(command);

async function configure(router: Shell, lines: readonly string[]): Promise<void> {
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  for (const line of lines) await router.executeCommand(line);
  await router.executeCommand('end');
}

async function lettingTimePass<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  await getSimulationClock()!.advance(milliseconds);
  return pending;
}

const ACL_LINES = [
  'interface GigabitEthernet0/0.99',
  'encapsulation dot1q 99',
  'ip address 10.0.20.2 255.255.255.0',
  'ip access-group 100 in',
  'exit',
  'router ospf 1',
  'router-id 192.168.60.1',
  'network 192.168.40.0 0.0.0.255 area 0',
  'network 192.168.50.0 0.0.0.255 area 0',
  'network 192.168.60.0 0.0.0.255 area 0',
  'network 10.0.20.0 0.0.0.255 area 0',
  'exit',
  "access-list 100 remark ===Refuser l'access en ssh de PC7 192.168.10.4 à Winserver3 192.168.60.2===",
  'access-list 100 deny tcp host 192.168.10.4 host 192.168.60.2 eq 22 log',
  'access-list 100 permit icmp any any',
  'access-list 100 permit udp host 192.168.10.4 host 192.168.60.2 log',
];

afterAll(() => { __resetSimulationClock(); });

describe('MAIN_RT_AKWA, ACL 100 in on GigabitEthernet0/0.99, nmap -sU from PC7', () => {
  it('behaves as IOS and nmap do, from the brief to the OSPF side effect', async () => {
    EquipmentRegistry.resetInstance();
    installSimulationClock();
    const imported = await importTopology(JSON.parse(readFileSync(EXPORT, 'utf8')));
    machines = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d as unknown as Shell]));
    for (const name of ROUTERS) {
      const router = machine(name);
      await configure(router, router.getPorts().flatMap((port) => [`interface ${port.getName()}`, 'no shutdown', 'exit']));
    }
    for (const name of ['PC7', 'WinServer3', 'PC4']) await machine(name).executeCmdCommand('ipconfig /renew');

    expect(await pc7('ipconfig'), 'PC7 address').toContain('192.168.10.4');
    expect(await machine('WinServer3').executeCmdCommand('ipconfig'), 'WinServer3 address').toContain('192.168.60.2');
    expect(await pc7('ping -n 1 192.168.60.2'), 'witness: reachable before the ACL').toContain('Received = 1');

    const before = await pc7('nmap -sU 192.168.60.2');
    expect(before, 'nmap -sU before the ACL').toContain('Not shown: 996 closed udp ports (port-unreach)');
    expect(before).toMatch(/53\/udp\s+open\|filtered\s+domain/);

    const router = machine('MAIN_RT_AKWA');
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    for (const line of ACL_LINES) expect(await router.executeCommand(line), line).not.toMatch(/Invalid|Incomplete|Ambiguous|%/);
    await router.executeCommand('end');

    const listing = await akwa('show access-lists');
    expect(listing).toContain('Extended IP access list 100');
    expect(listing).toContain("remark ===Refuser l'access en ssh");
    expect(listing).toMatch(/10 deny tcp host 192\.168\.10\.4 host 192\.168\.60\.2 eq 22 log/);
    expect(listing).toMatch(/20 permit icmp any any/);
    expect(listing).toMatch(/30 permit udp host 192\.168\.10\.4 host 192\.168\.60\.2 log/);
    expect(await akwa('show ip interface GigabitEthernet0/0.99'), 'inbound list').toContain('Inbound  access list is 100');
    const config = await akwa('show running-config');
    expect(config).toMatch(/interface GigabitEthernet0\/0\.99[\s\S]*ip access-group 100 in/);
    expect(config).toContain('access-list 100 deny tcp host 192.168.10.4 host 192.168.60.2 eq 22 log');

    const after = await pc7('nmap -sU 192.168.60.2');
    expect(after, 'nmap -sU after the ACL: same states').toContain('Not shown: 996 closed udp ports (port-unreach)');
    expect(after).toMatch(/123\/udp\s+open\|filtered\s+ntp/);
    expect(await akwa('show access-lists'), 'one match per probed port, two for the four silent ones').toMatch(/30 permit udp host 192\.168\.10\.4 host 192\.168\.60\.2 log \(1004 matches\)/);
    expect(await akwa('show access-lists'), 'echo and timestamp of the discovery').toMatch(/20 permit icmp any any \(2 matches\)/);
    expect(await akwa('show logging'), 'IOS log format').toMatch(/%SEC-6-IPACCESSLOGP: list 100 permitted udp 192\.168\.10\.4\(\d+\) -> 192\.168\.60\.2\(\d+\), 1 packet/);

    const ssh = await pc7('nmap -Pn -sS -p 22 --reason 192.168.60.2');
    expect(ssh, 'ssh denied').toMatch(/22\/tcp\s+filtered\s+ssh\s+admin-prohibited from 10\.0\.20\.2/);
    expect(await akwa('show access-lists')).toMatch(/10 deny tcp host 192\.168\.10\.4 host 192\.168\.60\.2 eq 22 log \(2 matches\)/);
    expect(await akwa('show logging')).toMatch(/list 100 denied tcp 192\.168\.10\.4\(\d+\) -> 192\.168\.60\.2\(22\), 1 packet/);

    const other = await machine('PC4').executeCmdCommand('nmap -sU -p 9999 192.168.60.2');
    expect(other, 'another host is refused').toMatch(/9999\/udp\s+open\|filtered/);
    expect(await akwa('show access-lists'), 'no counter moves for the refused host').toMatch(/30 permit udp host 192\.168\.10\.4 host 192\.168\.60\.2 log \(1004 matches\)/);

    expect(await akwa('show ip ospf neighbor'), 'adjacency before the dead interval').toContain('FULL');
    await getSimulationClock()!.advance(120_000);
    expect(await akwa('show ip ospf neighbor'), 'hellos eaten by the implicit deny').not.toContain('FULL');
    expect(await akwa('show logging')).toMatch(/Nbr 192\.168\.30\.1 on GigabitEthernet0\/0\.99 from Full to Down, InactivityTimer/);
    expect(await machine('MAIN_RT01').executeCommand('show ip ospf neighbor')).toMatch(/INIT/);
    expect(await lettingTimePass(pc7('ping -n 1 192.168.60.2'), 10_000), 'route gone').toContain('Destination net unreachable');

    await configure(router, ['access-list 100 permit ospf any any']);
    await getSimulationClock()!.advance(120_000);
    expect(await akwa('show ip ospf neighbor'), 'adjacency back').toContain('FULL');
    expect(await lettingTimePass(pc7('ping -n 1 192.168.60.2'), 5_000), 'ping back').toContain('Received = 1');
  }, 300_000);
});
