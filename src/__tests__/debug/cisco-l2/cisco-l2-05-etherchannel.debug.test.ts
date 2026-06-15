import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-05-etherchannel', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline EtherChannel state', cmd: 'enable' });
    for (const c of [
      'show etherchannel summary', 'show etherchannel detail',
      'show etherchannel load-balance', 'show etherchannel port-channel',
      'show pagp neighbor', 'show lacp neighbor', 'show lacp sys-id',
    ]) s.push(c);

    s.push({ section: 'global load-balance & LACP system priority', cmd: 'configure terminal' });
    s.push('port-channel load-balance src-dst-mac');
    s.push('do show etherchannel load-balance');
    s.push('port-channel load-balance src-dst-ip');
    s.push('lacp system-priority 100');
    s.push('do show lacp sys-id');
    s.push('end');

    s.push({ section: 'LACP bundles loop (channel-groups 1..5, mode active)', cmd: 'configure terminal' });
    let cg = 1;
    for (let base = 4; base <= 12; base += 2) {
      s.push(`interface range FastEthernet0/${base} - ${base + 1}`);
      s.push('switchport mode access');
      s.push('channel-protocol lacp');
      s.push(`channel-group ${cg} mode active`);
      s.push('exit');
      s.push(`interface Port-channel${cg}`);
      s.push('switchport mode trunk');
      s.push('exit');
      s.push(`do show etherchannel ${cg} summary`);
      cg += 1;
    }
    s.push('end');
    s.push('show etherchannel summary');

    s.push({ section: 'PAgP bundles loop (channel-groups 6..8, mode desirable)', cmd: 'configure terminal' });
    for (let base = 14; base <= 18; base += 2) {
      s.push(`interface range FastEthernet0/${base} - ${base + 1}`);
      s.push('switchport mode access');
      s.push('channel-protocol pagp');
      s.push(`channel-group ${cg} mode desirable`);
      s.push('exit');
      cg += 1;
    }
    s.push('end');
    s.push('show etherchannel summary');

    s.push({ section: 'static (mode on) bundle', cmd: 'configure terminal' });
    s.push('interface range FastEthernet0/20 - 21');
    s.push('switchport mode access');
    s.push(`channel-group ${cg} mode on`);
    s.push('exit');
    s.push('end');
    s.push('show etherchannel summary');

    s.push({ section: 'LACP per-port tuning loop', cmd: 'configure terminal' });
    for (let i = 4; i <= 12; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push(`lacp port-priority ${(i % 8 + 1) * 100}`);
      s.push('lacp rate fast');
      s.push('exit');
    }
    s.push('end');

    s.push({ section: 'mismatched-mode negative cases', cmd: 'configure terminal' });
    s.push('interface FastEthernet0/22');
    s.push('channel-group 1 mode passive');
    s.push('channel-group 99 mode bogus');
    s.push('channel-group abc mode active');
    s.push('exit');
    s.push('end');

    s.push({ section: 'CORE side bundle facing SW1', on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'configure terminal' });
    s.push({ on: 'core', cmd: 'interface GigabitEthernet0/1' });
    s.push({ on: 'core', cmd: 'channel-group 10 mode active' });
    s.push({ on: 'core', cmd: 'exit' });
    s.push({ on: 'core', cmd: 'interface Port-channel10' });
    s.push({ on: 'core', cmd: 'switchport mode trunk' });
    s.push({ on: 'core', cmd: 'end' });
    s.push({ on: 'core', cmd: 'show etherchannel summary' });
    s.push({ on: 'core', cmd: 'show etherchannel 10 detail' });

    s.push({ section: 'per-channel-group inspection loop' });
    for (let g = 1; g <= 9; g++) {
      s.push(`show etherchannel ${g} summary`);
      s.push(`show etherchannel ${g} port-channel`);
    }

    s.push({ section: 'per-port-channel running-config loop' });
    for (let g = 1; g <= 9; g++) {
      s.push(`show running-config interface Port-channel${g}`);
    }

    s.push({ section: 'teardown a bundle', cmd: 'configure terminal' });
    s.push('interface range FastEthernet0/4 - 5');
    s.push('no channel-group 1');
    s.push('exit');
    s.push('no interface Port-channel1');
    s.push('end');
    s.push('show etherchannel summary');

    s.push({ section: 'full inspection' });
    for (const c of [
      'show etherchannel summary', 'show etherchannel detail',
      'show etherchannel load-balance', 'show lacp neighbor', 'show lacp counters',
      'show pagp neighbor', 'show pagp counters', 'show interfaces status',
      'show spanning-tree summary',
    ]) s.push(c);

    s.push({ section: 'per-interface etherchannel state loop (Fa0/4..0/21)' });
    for (let i = 4; i <= 21; i++) {
      s.push(`show interfaces FastEthernet0/${i} etherchannel`);
    }
    s.push({ section: 'per-interface running-config loop (Fa0/4..0/21)' });
    for (let i = 4; i <= 21; i++) {
      s.push(`show running-config interface FastEthernet0/${i}`);
    }

    s.push({ section: 'SW2 LACP bundles', on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'configure terminal' });
    for (let base = 4; base <= 10; base += 2) {
      const g = (base / 2) - 1;
      s.push({ on: 'sw2', cmd: `interface range FastEthernet0/${base} - ${base + 1}` });
      s.push({ on: 'sw2', cmd: 'switchport mode access' });
      s.push({ on: 'sw2', cmd: `channel-group ${g} mode active` });
      s.push({ on: 'sw2', cmd: 'exit' });
      s.push({ on: 'sw2', cmd: `do show etherchannel ${g} summary` });
    }
    s.push({ on: 'sw2', cmd: 'interface GigabitEthernet0/1' });
    s.push({ on: 'sw2', cmd: 'channel-group 10 mode active' });
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'sw2', cmd: 'show etherchannel summary' });
    s.push({ on: 'sw2', cmd: 'show etherchannel detail' });
    s.push({ on: 'sw2', cmd: 'show lacp neighbor' });

    s.push({ section: 'host verification' });
    for (const on of ['l1', 'l2', 'srv1', 'srv2']) {
      s.push({ on, cmd: 'ip -br addr' });
      s.push({ on, cmd: 'ethtool eth0' });
    }
    s.push({ on: 'w1', cmd: 'ipconfig' });
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.13' });
    s.push({ on: 'sw1', cmd: 'show running-config' });

    await dumpL2('cisco-l2-05-etherchannel', topology, s,
      'focus=LACP/PAgP/static bundles, port-channel interfaces, load-balance, teardown');
  }, 180000);
});
