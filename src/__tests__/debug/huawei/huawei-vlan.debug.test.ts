/**
 * Huawei VRP VLAN management on an L2-only switch — create/delete,
 * vlan batch, access/trunk/hybrid port types, PVID, voice & MUX VLAN,
 * VLAN description, display vlan/port. Vlanif/L3 is exercised only to
 * confirm the L2 switch does not act as a router.
 *
 * 70 steps. Transcript dump for gap analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpHuawei, resetSim, type HuaweiStepInput } from './_huawei-suite';

describe('debug-dump: huawei-vlan', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();

    const steps: HuaweiStepInput[] = [
      { section: 'baseline', cmd: 'display vlan' },
      'display vlan summary',
      'system-view',
      'sysname SW-VLAN',

      { section: 'single VLAN lifecycle', cmd: 'vlan 10' },
      'name SALES',
      'description Sales department VLAN',
      'quit',
      'vlan 20',
      'name ENG',
      'description Engineering',
      'quit',
      'display vlan',
      'undo vlan 20',
      'display vlan',

      { section: 'vlan batch', cmd: 'vlan batch 100 200 300' },
      'vlan batch 30 to 35',
      'display vlan',
      'display vlan summary',
      'undo vlan batch 30 to 35',
      'display vlan',

      { section: 'access ports', cmd: 'interface GigabitEthernet0/0/1' },
      'port link-type access',
      'port default vlan 10',
      'display this',
      'quit',
      'interface GigabitEthernet0/0/3',
      'port link-type access',
      'port default vlan 10',
      'quit',

      { section: 'trunk ports', cmd: 'interface GigabitEthernet0/0/23' },
      'port link-type trunk',
      'port trunk allow-pass vlan 10 20 100',
      'port trunk allow-pass vlan all',
      'port trunk pvid vlan 99',
      'undo port trunk allow-pass vlan 100',
      'display this',
      'quit',

      { section: 'hybrid ports', cmd: 'interface GigabitEthernet0/0/2' },
      'port link-type hybrid',
      'port hybrid pvid vlan 10',
      'port hybrid tagged vlan 20 100',
      'port hybrid untagged vlan 10',
      'display this',
      'quit',

      { section: 'port-group bulk assign', cmd: 'port-group group-member GigabitEthernet0/0/4 to GigabitEthernet0/0/8' },
      'port link-type access',
      'port default vlan 200',
      'quit',

      { section: 'Vlanif/L3 on L2 switch (expect rejected/ignored — switch does not route)', cmd: 'interface Vlanif10' },
      'ip address 192.168.10.1 255.255.255.0',
      'description Gateway-SALES',
      'undo shutdown',
      'quit',
      'interface Vlanif20',
      'ip address 192.168.20.1 255.255.255.0',
      'quit',
      'display ip interface brief',

      { section: 'voice & mux vlan', cmd: 'vlan 50' },
      'quit',
      'interface GigabitEthernet0/0/2',
      'voice-vlan 50 enable',
      'quit',
      'vlan 60',
      'mux-vlan',
      'quit',

      { section: 'VLAN mapping / QinQ', cmd: 'interface GigabitEthernet0/0/23' },
      'port vlan-mapping vlan 10 map-vlan 1000',
      'qinq vlan-translation enable',
      'quit',
      'return',

      { section: 'inspection', cmd: 'display vlan' },
      'display vlan 10',
      'display port vlan',
      'display port vlan active',
      'display interface GigabitEthernet0/0/23',
      'display current-configuration interface GigabitEthernet0/0/23',
      'display current-configuration configuration vlan',
    ];

    await dumpHuawei(
      'huawei-vlan',
      topology,
      steps,
      'focus=L2 VLAN lifecycle, access/trunk/hybrid, voice/mux/QinQ (Vlanif shown only to confirm L2 switch rejects L3)',
    );
  });
});
