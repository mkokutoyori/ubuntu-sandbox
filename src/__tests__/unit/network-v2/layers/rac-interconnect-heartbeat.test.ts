/**
 * PRD-Suppression-Bus-Partage increment 4 — the RAC interconnect carries
 * a real heartbeat.
 *
 * Written BLIND, before touching `database/oracle/rac/`.
 *
 * MEASURED STARTING POINT. `RacCssAgent` is a cluster-wide singleton
 * that subscribes to `port.link.down` on the GLOBAL bus and evicts a
 * member when the event names its interconnect port. So a node is
 * evicted because an EVENT was read about another machine — the exact
 * thing a real cluster cannot do. On real Oracle Clusterware, CSS evicts
 * a node because its network heartbeat STOPPED ARRIVING over the
 * interconnect, and the misscount is what decides.
 *
 * The difference is not cosmetic and case 4 below is what proves it:
 * powering a node OFF publishes no link-down for its own port, so the
 * event-driven mechanism cannot notice — while a real cluster evicts it,
 * because the heartbeat simply stops. That case is the discriminator.
 *
 * Case 1 is the WITNESS and it is the most important one here: without
 * it, "the node was evicted" proves nothing at all — an implementation
 * that evicts everybody always would pass every other case.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { CSS_HEARTBEAT_INTERVAL_MS } from '@/database/oracle/rac/RacCssAgent';
import { getClusterByDbName } from '@/database/oracle/rac/RacClusterRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const MISSCOUNT_MS = 30_000;

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); resetAllOracleInstances(); Logger.reset();
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

function cluster() {
  const node1 = new LinuxServer('linux-server', 'racnode1', 0, 0);
  const node2 = new LinuxServer('linux-server', 'racnode2', 0, 0);
  const publicSw = new GenericSwitch('switch-generic', 'pubsw', 8, 0, 0);
  const icSw = new GenericSwitch('switch-generic', 'icsw', 8, 0, 0);

  new Cable('pub1').connect(node1.getPorts()[0], publicSw.getPorts()[0]);
  new Cable('pub2').connect(node2.getPorts()[0], publicSw.getPorts()[1]);
  new Cable('ic1').connect(node1.getPorts()[1], icSw.getPorts()[0]);
  new Cable('ic2').connect(node2.getPorts()[1], icSw.getPorts()[1]);

  const mask = new SubnetMask('255.255.255.0');
  node1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  node2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  node1.getPorts()[1].configureIP(new IPAddress('192.168.1.1'), mask);
  node2.getPorts()[1].configureIP(new IPAddress('192.168.1.2'), mask);

  node1.setHostname('racnode1');
  node2.setHostname('racnode2');
  SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']).subShell.dispose();
  return { node1, node2 };
}

function activeMembers(): number {
  const c = getClusterByDbName('ORCL');
  if (!c) return 0;
  return [...c.members.values()].filter(m => m.status === 'ACTIVE').length;
}

function cssLogOf(node: LinuxServer, host: string): string {
  return node.readFileForEditor(
    `/u01/app/grid/diag/crs/${host}/crs/trace/cssd.log`) ?? '';
}

describe('the interconnect carries a heartbeat, and its absence evicts', () => {
  it('TEMOIN: an intact interconnect evicts nobody', async () => {
    cluster();

    clock.advance(MISSCOUNT_MS * 3);

    expect(activeMembers()).toBe(2);
  });

  it('a healthy cluster puts real datagrams on the interconnect', async () => {
    const { node1 } = cluster();
    const seen: string[] = [];
    node1.attachCapture(t => seen.push(t.iface), node1.getPorts()[1].getName());

    clock.advance(CSS_HEARTBEAT_INTERVAL_MS * 3);

    expect(seen.length).toBeGreaterThan(0);
  });

  it('losing the interconnect evicts the node that went silent', async () => {
    const { node1, node2 } = cluster();

    await node1.executeCommand('ip link set eth1 down');
    clock.advance(MISSCOUNT_MS + CSS_HEARTBEAT_INTERVAL_MS);

    expect(cssLogOf(node2, 'racnode2')).toMatch(/evict/i);
    expect(cssLogOf(node2, 'racnode2')).toMatch(/racnode1/);
  });

  it('a node that stops sending is evicted even with its link up', async () => {
    const { node1, node2 } = cluster();

    node1.powerOff();
    clock.advance(MISSCOUNT_MS + CSS_HEARTBEAT_INTERVAL_MS);

    expect(cssLogOf(node2, 'racnode2')).toMatch(/racnode1/);
  });
});

describe('no RAC agent reads a shared bus', () => {
  it('neither agent calls getDefaultEventBus', async () => {
    const { readFileSync } = await import('node:fs');
    const offenders = [
      'src/database/oracle/rac/RacCssAgent.ts',
      'src/database/oracle/rac/RacCacheFusionAgent.ts',
    ].filter(p => /getDefaultEventBus/.test(readFileSync(p, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
