import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { PingResult } from '@/network/devices/EndHost';
import { formatWinPingReplyLine } from '@/network/devices/windows/WinPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

function winTopo(): { win: WindowsPC; peer: LinuxPC; cable: Cable } {
  const win = new WindowsPC('windows-pc', 'WIN1');
  const peer = new LinuxPC('linux-pc', 'PEER');
  win.configureInterface('eth0', new IPAddress('10.0.8.1'), MASK);
  peer.configureInterface('eth0', new IPAddress('10.0.8.2'), MASK);
  const cable = new Cable('c1');
  cable.connect(win.getPorts()[0], peer.getPort('eth0')!);
  return { win, peer, cable };
}

describe('Windows ping on a severed link (docs/PRD-Link-State.md §4 #7, P4)', () => {
  it('reports a transmit failure rather than a bare timeout', async () => {
    // Le critère §4 #7 du PRD demandait « Destination host unreachable »
    // ici. L'intention était juste — un lien coupé ne se dit pas
    // « Request timed out » — mais la chaîne ne l'était pas : sur un
    // vrai Windows, une carte sans lien perd sa route et la pile refuse
    // d'émettre, ce qui donne « PING: transmit failed. General
    // failure. ». « Destination host unreachable » reste la bonne
    // réponse pour une cible du même sous-réseau qui n'a pas répondu à
    // l'ARP — c'est le cas suivant.
    const { win, cable } = winTopo();
    await win.executeCommand('ping -n 1 10.0.8.2');
    cable.disconnect();

    const out = await win.executeCommand('ping -n 2 10.0.8.2');
    expect(out).toContain('PING: transmit failed. General failure.');
    expect(out).not.toContain('Request timed out');
  }, 30000);

  it('a silent neighbour on an intact link is the unreachable case', async () => {
    const { win } = winTopo();
    const out = await win.executeCommand('ping -n 2 10.0.8.77');
    expect(out).toContain('Reply from 10.0.8.1: Destination host unreachable.');
    expect(out).not.toContain('PING: transmit failed');
  }, 30000);

  it('still succeeds while the cable is plugged in', async () => {
    const { win } = winTopo();
    const out = await win.executeCommand('ping -n 2 10.0.8.2');
    expect(out).toContain('Reply from 10.0.8.2');
    expect(out).not.toContain('Destination host unreachable');
  }, 30000);

  it('ping -t (continuous) keeps printing a visible failure after a mid-stream unplug', async () => {
    const { win, cable } = winTopo();
    const results: PingResult[] = [];
    let n = 0;
    await win.pingStreamInSession('10.0.8.2', {
      count: 5,
      timeoutMs: 300,
      intervalMs: 0,
      onResult: (r) => { results.push(r); if (++n === 2) cable.disconnect(); },
      shouldStop: () => false,
      sleep: async () => {},
    });

    expect(results).toHaveLength(5);
    const after = results.slice(2);
    expect(after.every((r) => !r.success)).toBe(true);
    for (const r of after) {
      expect(formatWinPingReplyLine(r, 32)).toContain('Destination host unreachable');
    }
  }, 30000);
});

async function ciscoTopo(): Promise<{ r: CiscoRouter; peer: LinuxPC; cable: Cable }> {
  const r = new CiscoRouter('router-cisco', 'R1');
  const peer = new LinuxPC('linux-pc', 'PEER');
  const rp = r.getPorts()[0];
  peer.configureInterface('eth0', new IPAddress('10.0.7.2'), MASK);
  const cable = new Cable('c1');
  cable.connect(rp, peer.getPort('eth0')!);

  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 10.0.7.1 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
  return { r, peer, cable };
}

describe('Cisco ping on a severed link (docs/PRD-Link-State.md §4 #8, P4)', () => {
  it('every probe fails once the cable is pulled', async () => {
    const { r, cable } = await ciscoTopo();
    const ok = await r.executePingSequence(new IPAddress('10.0.7.2'), 2, 500);
    expect(ok.some((x) => x.success)).toBe(true);

    cable.disconnect();
    const after = await r.executePingSequence(new IPAddress('10.0.7.2'), 5, 500);
    expect(after.every((x) => !x.success)).toBe(true);
  }, 30000);
});

async function huaweiTopo(): Promise<{ r: HuaweiRouter; peer: LinuxPC; cable: Cable }> {
  const r = new HuaweiRouter('router-huawei', 'R1');
  const peer = new LinuxPC('linux-pc', 'PEER');
  const rp = r.getPorts()[0];
  peer.configureInterface('eth0', new IPAddress('10.0.6.2'), MASK);
  const cable = new Cable('c1');
  cable.connect(rp, peer.getPort('eth0')!);

  await r.executeCommand('system-view');
  await r.executeCommand(`interface ${rp.getName()}`);
  await r.executeCommand('ip address 10.0.6.1 255.255.255.0');
  await r.executeCommand('undo shutdown');
  await r.executeCommand('quit');
  return { r, peer, cable };
}

describe('Huawei ping on a severed link (docs/PRD-Link-State.md §4 #8, P4)', () => {
  it('every probe fails once the cable is pulled', async () => {
    const { r, cable } = await huaweiTopo();
    const ok = await r.executePingSequence(new IPAddress('10.0.6.2'), 2, 500);
    expect(ok.some((x) => x.success)).toBe(true);

    cable.disconnect();
    const after = await r.executePingSequence(new IPAddress('10.0.6.2'), 5, 500);
    expect(after.every((x) => !x.success)).toBe(true);
  }, 30000);
});
