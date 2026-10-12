/**
 * `monitor capture` de l'Embedded Packet Capture d'IOS-XE : un tampon (`buffer`), un point de capture (`point ip cef`), leur association, puis
 * `start`/`stop` ; `show monitor capture buffer … dump` imprime les octets, `export` produit un fichier relisible par `tcpdump -r`. La capture écoute
 * les trames du port par le même point d'observation que tcpdump, et le filtre `pcap` est la grammaire BPF de tcpdump (une seule dans le dépôt) ;
 * `filter access-list` consulte la vraie ACL du routeur.
 *
 * MESURÉ avant correctif : toute la famille répondait « Unknown command or computer name » (le routeur traduisait `monitor` comme un nom d'hôte).
 * Avant correctif (git stash de src/network) tous les cas tombent sauf le témoin, qui prouve que le laboratoire fait passer du trafic.
 * Le format des vues (`show … parameters`, l'adresse hexadécimale de la colonne de gauche du dump) suit les transcriptions publiques de la documentation
 * Cisco « Embedded Packet Capture », non vérifiables depuis ce réseau.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

const run = (d: unknown, c: string) => (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function lab() {
  const r1 = new CiscoRouter('R1');
  const a = new LinuxPC('linux-pc', 'A');
  const b = new LinuxPC('linux-pc', 'B');
  new Cable('ca').connect(a.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('cb').connect(b.getPort('eth0')!, r1.getPort('GigabitEthernet0/1')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip access-list extended ONLY-ICMP', 'permit icmp any any', 'exit', 'end']) await run(r1, c);
  await run(a, 'ip addr add 10.0.1.10/24 dev eth0'); await run(a, 'ip link set eth0 up'); await run(a, 'ip route add default via 10.0.1.1');
  await run(b, 'ip addr add 10.0.2.10/24 dev eth0'); await run(b, 'ip link set eth0 up'); await run(b, 'ip route add default via 10.0.2.1');
  return { r1, a, b };
}

async function capture(r1: unknown, extra = '') {
  await run(r1, `monitor capture buffer BUF size 512 max-size 128 circular ${extra}`.trim());
  await run(r1, 'monitor capture point ip cef P1 GigabitEthernet0/0 both');
  await run(r1, 'monitor capture point associate P1 BUF');
  await run(r1, 'monitor capture point start P1');
}

describe('Cisco monitor capture (EPC)', () => {
  it('témoin : le laboratoire fait passer du trafic à travers le routeur', async () => {
    const { a } = await lab();
    expect(await run(a, 'ping -c 1 10.0.2.10')).toMatch(/1 received|0% packet loss/);
  });

  it('un tampon, un point, l\'association : show … parameters et show … point disent l\'état', async () => {
    const { r1 } = await lab();
    await capture(r1);
    const parameters = await run(r1, 'show monitor capture buffer BUF parameters');
    expect(parameters).toContain('Capture buffer BUF (circular buffer)');
    expect(parameters).toContain('Buffer Size : 524288 bytes, Max Element Size : 128 bytes');
    expect(parameters).toContain('Name : P1, Status : Active');
    const point = await run(r1, 'show monitor capture point all');
    expect(point).toContain('Status Information for Capture Point P1');
    expect(point).toContain('Applied Interface: GigabitEthernet0/0, Direction: both');
  });

  it('les paquets du port sont capturés, show … dump imprime les octets IPv4', async () => {
    const { r1, a } = await lab();
    await capture(r1);
    await run(a, 'ping -c 2 10.0.2.10');
    await run(r1, 'monitor capture point stop P1');
    expect(await run(r1, 'show monitor capture buffer BUF parameters')).toMatch(/Packets : [1-9]/);
    const dump = await run(r1, 'show monitor capture buffer BUF dump');
    expect(dump).toContain('IPv4 | CEF');
    expect(dump).toMatch(/^[0-9A-F]{8}: 45/m);
  });

  it('le filtre pcap est la grammaire BPF de tcpdump : tcp ne retient pas le ping', async () => {
    const { r1, a } = await lab();
    await capture(r1, 'filter pcap tcp');
    await run(a, 'ping -c 2 10.0.2.10');
    await run(r1, 'monitor capture point stop P1');
    expect(await run(r1, 'show monitor capture buffer BUF parameters')).toContain('Packets : 0');
  });

  it('filter access-list consulte la vraie ACL : une ACL icmp retient le ping', async () => {
    const { r1, a } = await lab();
    await capture(r1, 'filter access-list ONLY-ICMP');
    await run(a, 'ping -c 2 10.0.2.10');
    await run(r1, 'monitor capture point stop P1');
    expect(await run(r1, 'show monitor capture buffer BUF parameters')).toMatch(/Packets : [1-9]/);
  });

  it('une ACL inexistante est refusée', async () => {
    const { r1 } = await lab();
    expect(await run(r1, 'monitor capture buffer BUF filter access-list NOPE')).toContain('% Invalid input');
  });

  it('un tampon linéaire plein arrête le point ; limit packets aussi', async () => {
    const { r1, a } = await lab();
    await run(r1, 'monitor capture buffer SMALL size 1 max-size 68 linear limit packets 2');
    await run(r1, 'monitor capture point ip cef P2 GigabitEthernet0/0 both');
    await run(r1, 'monitor capture point associate P2 SMALL');
    await run(r1, 'monitor capture point start P2');
    await run(a, 'ping -c 4 10.0.2.10');
    expect(await run(r1, 'show monitor capture buffer SMALL parameters')).toContain('Packets : 2');
    expect(await run(r1, 'show monitor capture point P2')).toContain('Status : Inactive');
  });

  it("l'export écrit un fichier sur flash: que tcpdump -r saurait relire, et clear vide le tampon", async () => {
    const { r1, a } = await lab();
    await capture(r1);
    await run(a, 'ping -c 1 10.0.2.10');
    await run(r1, 'monitor capture point stop P1');
    await run(r1, 'monitor capture buffer BUF export flash:cap.pcap');
    expect(await run(r1, 'dir flash:')).toContain('cap.pcap');
    await run(r1, 'monitor capture buffer BUF clear');
    expect(await run(r1, 'show monitor capture buffer BUF parameters')).toContain('Packets : 0');
  });

  it('démarrer un point sans tampon associé est refusé ; no supprime point et tampon', async () => {
    const { r1 } = await lab();
    await run(r1, 'monitor capture point ip cef P3 GigabitEthernet0/0 in');
    expect(await run(r1, 'monitor capture point start P3')).toContain('no capture buffer associated');
    await run(r1, 'no monitor capture point ip cef P3');
    expect(await run(r1, 'show monitor capture point P3')).toContain('does not exist');
    await run(r1, 'monitor capture buffer TMP');
    await run(r1, 'no monitor capture buffer TMP');
    expect(await run(r1, 'show monitor capture buffer TMP')).toContain('does not exist');
  });
});
