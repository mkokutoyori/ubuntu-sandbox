import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

async function enConfig(): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  for (const c of ['enable', 'configure terminal']) await device.executeCommand(c);
  return device;
}

/*
 * NAT et PIM globaux : les deux familles dont la moitie INTERFACE est
 * deja migree. Les formes sont relevees sur les gestionnaires et ce
 * bloc est passe sur le code NON MIGRE avant de l'etre.
 *
 * Ces gestionnaires VALIDENT ET EXPLIQUENT beaucoup — nom de reserve
 * trop long, plage mal alignee sur le masque, debut superieur a la fin,
 * mot-cle `netmask` attendu — et l'analyse ne peut trancher aucun de
 * ces cas. Les places ne devront donc pas les devancer.
 */
const REGLAGES: ReadonlyArray<string> = [
  'ip nat pool PUB 200.0.0.1 200.0.0.10 netmask 255.255.255.0',
  'ip nat pool PUB2 200.0.1.1 200.0.1.10 prefix-length 24',
  'no ip nat pool PUB',
  'ip nat inside source static 10.0.0.1 200.0.0.1',
  'ip nat inside source static tcp 10.0.0.1 80 200.0.0.1 8080',
  'ip nat inside source static udp 10.0.0.1 53 200.0.0.1 53',
  'no ip nat inside source static 10.0.0.1 200.0.0.1',
  'ip nat inside source list 1 pool PUB',
  'ip nat inside source list 1 pool PUB overload',
  'ip nat inside source list 1 interface GigabitEthernet0/0 overload',
  'no ip nat inside source list 1',
  'ip nat outside source static 200.0.0.9 10.0.0.9',
  'ip nat translation timeout 3600',
  'ip nat translation tcp-timeout 600',
  'ip nat translation udp-timeout 300',
  'ip nat translation icmp-timeout 60',
  'ip nat translation dns-timeout 60',
  'ip nat translation syn-timeout 60',
  'ip nat translation finrst-timeout 60',
  'ip nat translation max-entries 1000',
  'ip nat log translations syslog',
  'ip nat service all-algs',
  'ip pim rp-address 10.0.0.1',
  'ip pim spt-threshold 0',
  'ip pim join-prune-interval 60',
  'ip pim send-rp-announce Loopback0 scope 16',
  'ip pim send-rp-discovery Loopback0 scope 16',
  'ip pim bsr-candidate Loopback0',
  'ip pim rp-candidate Loopback0',
  'no ip pim rp-address 10.0.0.1',
];

describe('NAT et PIM globaux restent acceptes', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await enConfig()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('le gestionnaire garde ses refus, qui EXPLIQUENT', () => {
  it.each([
    ['ip nat pool CE-NOM-EST-BEAUCOUP-TROP-LONG-POUR-IOS 1.1.1.1 1.1.1.2 netmask 255.255.255.0',
      'exceeds 31 characters'],
    ['ip nat pool BAD 1.1.1.10 1.1.1.1 netmask 255.255.255.0', 'greater than end IP'],
    ['ip nat pool BAD 1.1.1.1 1.1.1.2 zorglub 255.255.255.0', 'netmask'],
    ['ip nat inside source static tcp 10.0.0.1 70000 200.0.0.1 80', 'Invalid port number'],
    ['ip nat inside source list 1 interface GigabitEthernet0/0', 'overload'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s` explique', async (commande, attendu) => {
      expect(await (await enConfig()).executeCommand(commande)).toContain(attendu);
    });
});

describe('l\'aide nomme les places de NAT et PIM', () => {
  it.each([
    ['ip nat ', 'pool'],
    ['ip nat inside ', 'source'],
    ['ip pim ', 'rp-address'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s?` annonce %s', async (saisie, attendu) => {
      expect((await enConfig()).cliHelp(saisie)).toContain(attendu);
    });
});
