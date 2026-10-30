/**
 * Une trace n'est pas une panne : chaque saut intermediaire REPOND par un « Time Exceeded » parce que la sonde porte un TTL trop court, et
 * c'est ce que `tracert` / `traceroute` veulent lire. Un vrai hote n'ecrit rien pour cela.
 *
 * Mesure de depart (WIN -> routeur -> serveur, trois sondes par saut) : `tracert` laissait trois lignes `warn icmp:echo-failed`
 * (« WIN: ICMP echo to 10.0.2.2 failed (Time to live exceeded (from 10.0.1.1)) »), `traceroute -I` trois, et `traceroute` (sondes UDP)
 * SIX : un « echo » qui n'en etait pas un, l'erreur ICMP revenant pour un datagramme UDP et etant rangee en echec d'echo a l'identite -1.
 *
 * Ce qui reste un echec et reste journalise (TEMOIN) : un `ping` dont le TTL expire en route, qui n'est pas une trace.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function lab() {
  const r1 = new CiscoRouter('R1');
  const win = new WindowsPC('windows-pc', 'WIN');
  const lin = new LinuxPC('linux-pc', 'LIN');
  const dst = new LinuxPC('linux-pc', 'DST');
  win.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  lin.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/2', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  dst.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
  win.setDefaultGateway(new IPAddress('10.0.1.1'));
  lin.setDefaultGateway(new IPAddress('10.0.3.1'));
  dst.setDefaultGateway(new IPAddress('10.0.2.1'));
  new Cable('a').connect(win.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, dst.getPort('eth0')!);
  new Cable('c').connect(lin.getPort('eth0')!, r1.getPort('GigabitEthernet0/2')!);
  return { win, lin };
}

const complaints = (): string[] => Logger.getLogs()
  .filter((log) => (log.level === 'warn' || log.level === 'error') && log.event.startsWith('icmp:'))
  .map((log) => `${log.level} ${log.event} ${log.message}`);

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('une trace ne journalise pas d\'echec ICMP', () => {
  it('tracert (sondes ICMP)', async () => {
    const { win } = lab();
    expect(await win.executeCommand('tracert 10.0.2.2')).toContain('Trace complete');
    Logger.reset();
    await win.executeCommand('tracert 10.0.2.2');
    expect(complaints()).toEqual([]);
  });

  it('traceroute -I (sondes ICMP)', async () => {
    const { lin } = lab();
    Logger.reset();
    expect(await lin.executeCommand('traceroute -I 10.0.2.2')).toContain('10.0.3.1');
    expect(complaints()).toEqual([]);
  });

  it('traceroute (sondes UDP)', async () => {
    const { lin } = lab();
    Logger.reset();
    expect(await lin.executeCommand('traceroute 10.0.2.2')).toContain('10.0.3.1');
    expect(complaints()).toEqual([]);
  });

  it('TEMOIN : un ping dont le TTL expire en route reste un echec journalise', async () => {
    const { lin } = lab();
    Logger.reset();
    await lin.executeCommand('ping -c 1 -t 1 10.0.2.2');
    expect(complaints()).toHaveLength(1);
    expect(complaints()[0]).toContain('Time to live exceeded');
  });
});
