/**
 * `config router bgp` : `set default-local-preference` et, par voisin, `set shutdown enable|disable` (FortiOS CLI Reference 7.4.12 p.1126+ ; le moteur BGP les
 * honore deja -- `BgpNeighborCfg.shutdown`, `BGPConfig.defaultLocalPref` -- mais le schema FortiGate ne les exposait pas).
 * `shutdown enable` ferme la session du voisin (il quitte Established) et `disable` la rouvre ; `default-local-preference` fixe la LOCAL_PREF
 * des routes que la FortiGate origine (lue dans la table du moteur BGP : la vue `show ip bgp` du Cisco n'affiche pas la LocPrf recue, ce qui est une autre limite).
 * Mesure de depart : « unknown attribute » pour les deux ; les 4 cas tombent avant, sauf le temoin (le pairage s'etablit).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function peering(remoteAs = 65002) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const neighbour = new CiscoRouter('R1', 200, 0);
  new Cable('transit').connect(firewall.getPort('port2')!, neighbour.getPort('GigabitEthernet0/0')!);
  await type(firewall, ['config system interface', 'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next', 'end']);
  await type(neighbour, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
    `router bgp ${remoteAs}`, 'bgp router-id 2.2.2.2', 'neighbor 10.1.0.1 remote-as 65001', 'end']);
  await type(firewall, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'end',
    'config neighbor', 'edit "10.1.0.2"', `set remote-as ${remoteAs}`, 'next', 'end', 'end']);
  clock.advance(120_000);
  return { firewall, neighbour };
}

const seen = (neighbour: CiscoRouter) => neighbour.executeCommand('show ip bgp neighbors 10.1.0.1');

describe('router bgp shutdown et default-local-preference', () => {
  it('TEMOIN : le pairage s\'etablit', async () => {
    const { neighbour } = await peering();
    expect(await seen(neighbour)).toContain('BGP state = Established');
  });

  it('shutdown enable sort le voisin de Established', async () => {
    const { firewall, neighbour } = await peering();
    await type(firewall, ['config router bgp', 'config neighbor', 'edit "10.1.0.2"', 'set shutdown enable', 'next', 'end', 'end']);
    clock.advance(120_000);
    expect(await seen(neighbour)).not.toContain('BGP state = Established');
  });

  it('shutdown disable rouvre la session', async () => {
    const { firewall, neighbour } = await peering();
    await type(firewall, ['config router bgp', 'config neighbor', 'edit "10.1.0.2"', 'set shutdown enable', 'next', 'end', 'end']);
    clock.advance(120_000);
    await type(firewall, ['config router bgp', 'config neighbor', 'edit "10.1.0.2"', 'set shutdown disable', 'next', 'end', 'end']);
    clock.advance(240_000);
    expect(await seen(neighbour)).toContain('BGP state = Established');
  });

  it('default-local-preference fixe la LOCAL_PREF vue par un pair iBGP', async () => {
    const { firewall, neighbour } = await peering(65001);
    await type(firewall, ['config router bgp', 'set default-local-preference 250', 'end']);
    clock.advance(240_000);
    const rows = (firewall as unknown as { getRouting(): { getBgp(): { getEngine(): { getBgpTable(): { localPref: number }[] } } } }).getRouting().getBgp().getEngine().getBgpTable();
    expect(rows.map((row) => row.localPref)).toEqual([250]);
  });

  it('default-local-preference est rendu par show', async () => {
    const { firewall } = await peering();
    await type(firewall, ['config router bgp', 'set default-local-preference 250', 'end']);
    expect(await firewall.executeCommand('show router bgp')).toContain('set default-local-preference 250');
  });
});
