/**
 * `show` at privilege level 1. Real IOS keeps almost the whole show family
 * in user EXEC — only running-config, startup-config, tech-support and
 * archive are privileged — and the simulator mirrors the privileged trie
 * into the user one to model that.
 *
 * The mirroring used to skip any keyword the user trie already carried, so
 * a partial registration masked everything behind it: `show interfaces
 * counters errors` alone was enough for the switch to reject `show
 * interfaces status` at level 1 while answering it at level 15.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function cabledSwitch(): CiscoSwitch {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const pc = new WindowsPC('windows-pc', 'PC', 0, 0);
  new Cable('c').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  return sw;
}

describe('switch — the show family is reachable at level 1', () => {
  it('`show interfaces status` answers the same table in user EXEC as in privileged', async () => {
    const sw = cabledSwitch();
    const asUser = await sw.executeCommand('show interfaces status');
    await sw.executeCommand('enable');
    const asPrivileged = await sw.executeCommand('show interfaces status');

    expect(asUser, 'a level-1 command must not be rejected').not.toContain('Invalid input');
    expect(asUser).toMatch(/Fa0\/1\s+connected/);
    expect(asUser).toBe(asPrivileged);
  });

  it('`show interfaces` with no argument is not reported as incomplete', async () => {
    const sw = cabledSwitch();
    const out = await sw.executeCommand('show interfaces');

    expect(out).not.toContain('Incomplete command');
    expect(out).toMatch(/FastEthernet0\/1 is up, line protocol is up/);
  });

  it('`show interfaces trunk` is reachable at level 1', async () => {
    const sw = cabledSwitch();
    expect(await sw.executeCommand('show interfaces trunk')).not.toContain('Invalid input');
  });

  it('the partial registration that masked the subtree still resolves on its own', async () => {
    const sw = cabledSwitch();
    const out = await sw.executeCommand('show interfaces counters errors');

    expect(out).not.toContain('Invalid input');
    expect(out).toMatch(/Port|Align-Err|FCS-Err/);
  });
});

describe('the privileged-only show commands stay privileged', () => {
  it.each(['show running-config', 'show startup-config', 'show tech-support'])(
    '%s is refused in user EXEC on the switch',
    async (cmd) => {
      const sw = cabledSwitch();
      const out = await sw.executeCommand(cmd);
      expect(out).not.toMatch(/hostname|Building configuration/);
    },
  );

  it.each(['show running-config', 'show startup-config'])(
    '%s is refused in user EXEC on the router',
    async (cmd) => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand(cmd);
      expect(out).not.toMatch(/hostname|Building configuration/);
    },
  );

  it('`show running-config` still works once enabled', async () => {
    const sw = cabledSwitch();
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('show running-config')).toMatch(/hostname/);
  });
});

describe('router — mirroring does not lose the user trie s own commands', () => {
  it('`show version` and `show ip interface brief` still answer at level 1', async () => {
    const r = new CiscoRouter('R1');
    expect(await r.executeCommand('show version')).toMatch(/Cisco IOS Software/);
    expect(await r.executeCommand('show ip interface brief')).toMatch(/Interface\s+IP-Address/);
  });

  /**
   * `show interfaces status` est une commande de commutation LAN : elle
   * vit sur un Catalyst, pas sur un routeur sans module EtherSwitch — un
   * vrai ISR répond `% Invalid input detected at '^' marker.`. Le cas
   * switch est couvert plus haut, et le commit qui a introduit ce
   * fichier énumère lui-même ce que le ROUTEUR avait gagné :
   * `show crypto engine brief` et `show crypto engine configuration`.
   * C'est donc sur celles-là que porte la non-régression côté routeur ;
   * exiger la commande de switch ici demandait au routeur d'être ce
   * qu'il n'est pas.
   */
  it('les commandes gagnées par le routeur répondent bien au niveau 1', async () => {
    const r = new CiscoRouter('R1');
    expect(await r.executeCommand('show crypto engine brief')).not.toContain('Invalid input');
    expect(await r.executeCommand('show crypto engine configuration')).not.toContain('Invalid input');
  });

  it('une commande de switch reste refusée sur un routeur', async () => {
    const r = new CiscoRouter('R1');
    expect(await r.executeCommand('show interfaces status')).toContain('Invalid input');
  });
});
