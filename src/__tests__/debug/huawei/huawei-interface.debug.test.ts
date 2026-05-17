/**
 * Huawei VRP interface management — description, shutdown, speed/duplex,
 * MTU/jumbo, flow-control, link aggregation (Eth-Trunk / LACP), loopback,
 * port isolation, storm suppression, display interface family.
 *
 * 68 steps. Transcript dump for gap analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpHuawei, resetSim, type HuaweiStepInput } from './_huawei-suite';

describe('debug-dump: huawei-interface', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();

    const steps: HuaweiStepInput[] = [
      { section: 'inventory', cmd: 'display interface brief' },
      'display interface',
      'display interface description',
      'display ip interface brief',
      'display port',

      { section: 'physical config', cmd: 'system-view' },
      'sysname SW-INT',
      'interface GigabitEthernet0/0/1',
      'description >> uplink to L1 <<',
      'speed 1000',
      'duplex full',
      'negotiation auto',
      'flow-control',
      'mtu 9216',
      'jumboframe enable 9216',
      'port-security enable',
      'port-security max-mac-num 5',
      'loopback-detect enable',
      'display this',
      'quit',

      { section: 'shutdown / state', cmd: 'interface GigabitEthernet0/0/5' },
      'shutdown',
      'quit',
      'display interface brief',
      'interface GigabitEthernet0/0/5',
      'undo shutdown',
      'quit',
      'display interface GigabitEthernet0/0/5',

      { section: 'range / port-group', cmd: 'port-group pg1' },
      'group-member GigabitEthernet0/0/6 to GigabitEthernet0/0/9',
      'quit',
      'interface range GigabitEthernet0/0/6 to GigabitEthernet0/0/9',
      'shutdown',
      'quit',

      { section: 'Eth-Trunk / LACP', cmd: 'interface Eth-Trunk 1' },
      'mode lacp-static',
      'trunkport GigabitEthernet0/0/21',
      'trunkport GigabitEthernet0/0/22',
      'max active-linknumber 2',
      'least active-linknumber 1',
      'load-balance src-dst-mac',
      'display this',
      'quit',
      'interface GigabitEthernet0/0/21',
      'eth-trunk 1',
      'quit',
      'interface GigabitEthernet0/0/22',
      'eth-trunk 1',
      'quit',
      'display eth-trunk 1',
      'display interface Eth-Trunk 1',

      { section: 'loopback / vlanif / null', cmd: 'interface LoopBack0' },
      'ip address 10.0.0.1 255.255.255.255',
      'quit',
      'interface NULL0',
      'quit',

      { section: 'port isolation', cmd: 'interface GigabitEthernet0/0/3' },
      'port-isolate enable group 1',
      'quit',
      'interface GigabitEthernet0/0/4',
      'port-isolate enable group 1',
      'quit',

      { section: 'storm / traffic control', cmd: 'interface GigabitEthernet0/0/2' },
      'storm-control broadcast min-rate 100 max-rate 200',
      'storm-control multicast min-rate 100 max-rate 200',
      'broadcast-suppression 10',
      'traffic-policy P1 inbound',
      'quit',
      'return',

      { section: 'counters / diagnostics', cmd: 'display interface GigabitEthernet0/0/1' },
      'display interface GigabitEthernet0/0/1 | include rate',
      'reset counters interface GigabitEthernet0/0/1',
      'display counters inbound interface GigabitEthernet0/0/1',
      'display interface brief | include up',
    ];

    await dumpHuawei(
      'huawei-interface',
      topology,
      steps,
      'focus=interface physical config, Eth-Trunk/LACP, isolation, storm-ctl',
      { resyncSwitchPerSection: true },
    );
  });
});
