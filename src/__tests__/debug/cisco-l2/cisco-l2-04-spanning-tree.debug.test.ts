import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-04-spanning-tree', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline STP state', cmd: 'enable' });
    for (const c of [
      'show spanning-tree', 'show spanning-tree summary', 'show spanning-tree root',
      'show spanning-tree bridge', 'show spanning-tree detail',
      'show spanning-tree blockedports', 'show spanning-tree inconsistentports',
      'show spanning-tree active', 'show spanning-tree pathcost method',
    ]) s.push(c);

    s.push({ section: 'STP mode selection', cmd: 'configure terminal' });
    s.push('spanning-tree mode pvst');
    s.push('do show spanning-tree summary');
    s.push('spanning-tree mode rapid-pvst');
    s.push('do show spanning-tree summary');
    s.push('spanning-tree mode mst');
    s.push('do show spanning-tree summary');
    s.push('spanning-tree mode rapid-pvst');
    s.push('end');

    s.push({ section: 'create VLANs for per-VLAN STP', cmd: 'configure terminal' });
    for (let v = 10; v <= 100; v += 10) {
      s.push(`vlan ${v}`);
      s.push('exit');
    }

    s.push({ section: 'root bridge / priority per VLAN loop' });
    for (let v = 10; v <= 100; v += 10) {
      s.push(`spanning-tree vlan ${v} priority ${4096 * ((v / 10) % 8 + 1) % 61440}`);
    }
    s.push('spanning-tree vlan 10 root primary');
    s.push('spanning-tree vlan 20 root secondary');
    s.push('do show spanning-tree root');
    s.push('spanning-tree vlan 1 priority 24576');
    s.push('spanning-tree vlan 1 hello-time 2');
    s.push('spanning-tree vlan 1 forward-time 15');
    s.push('spanning-tree vlan 1 max-age 20');
    s.push('do show spanning-tree vlan 1');
    s.push('end');

    s.push({ section: 'global STP features', cmd: 'configure terminal' });
    s.push('spanning-tree portfast default');
    s.push('spanning-tree portfast bpduguard default');
    s.push('spanning-tree portfast bpdufilter default');
    s.push('spanning-tree loopguard default');
    s.push('spanning-tree extend system-id');
    s.push('spanning-tree pathcost method long');
    s.push('spanning-tree uplinkfast');
    s.push('spanning-tree backbonefast');
    s.push('do show spanning-tree summary');
    s.push('end');

    s.push({ section: 'per-interface STP config loop (Fa0/1..0/20)', cmd: 'configure terminal' });
    for (let i = 1; i <= 20; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('spanning-tree portfast');
      s.push('spanning-tree bpduguard enable');
      s.push(`spanning-tree cost ${19 * i}`);
      s.push(`spanning-tree port-priority ${(i % 8) * 16}`);
      s.push('exit');
    }
    s.push('end');

    s.push({ section: 'edge guards on access ports', cmd: 'configure terminal' });
    s.push('interface FastEthernet0/1');
    s.push('spanning-tree guard root');
    s.push('exit');
    s.push('interface FastEthernet0/2');
    s.push('spanning-tree guard loop');
    s.push('spanning-tree bpdufilter enable');
    s.push('exit');
    s.push('interface GigabitEthernet0/1');
    s.push('spanning-tree link-type point-to-point');
    s.push('exit');
    s.push('end');

    s.push({ section: 'MST region configuration', cmd: 'configure terminal' });
    s.push('spanning-tree mode mst');
    s.push('spanning-tree mst configuration');
    s.push('name REGION1');
    s.push('revision 5');
    s.push('instance 1 vlan 10,20,30');
    s.push('instance 2 vlan 40,50,60');
    s.push('show current');
    s.push('show pending');
    s.push('exit');
    s.push('spanning-tree mst 1 priority 4096');
    s.push('spanning-tree mst 2 priority 8192');
    s.push('do show spanning-tree mst');
    s.push('do show spanning-tree mst configuration');
    s.push('do show spanning-tree mst 1');
    s.push('end');

    s.push({ section: 'inspection after config' });
    for (const c of [
      'show spanning-tree', 'show spanning-tree summary', 'show spanning-tree root',
      'show spanning-tree vlan 10', 'show spanning-tree vlan 20',
      'show spanning-tree interface FastEthernet0/1',
      'show spanning-tree interface FastEthernet0/1 detail',
      'show spanning-tree blockedports', 'show spanning-tree inconsistentports',
      'show spanning-tree mst', 'show errdisable recovery',
    ]) s.push(c);

    s.push({ section: 'per-VLAN STP inspection loop' });
    for (let v = 10; v <= 100; v += 10) {
      s.push(`show spanning-tree vlan ${v}`);
    }

    s.push({ section: 'per-interface STP inspection loop' });
    for (let i = 1; i <= 23; i++) {
      s.push(`show spanning-tree interface FastEthernet0/${i}`);
    }

    s.push({ section: 'topology-change trigger via link down', cmd: 'debug spanning-tree events' });
    s.push({ on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/3' });
    s.push({ on: 'sw1', cmd: 'shutdown' });
    s.push({ on: 'sw1', cmd: 'no shutdown' });
    s.push({ on: 'sw1', cmd: 'end' });
    s.push({ on: 'srv1', cmd: 'ip -br link' });
    s.push({ on: 'sw1', cmd: 'show spanning-tree summary' });
    s.push({ on: 'sw1', cmd: 'undebug all' });

    s.push({ section: 'CORE & SW2 STP roles', on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'show spanning-tree summary' });
    s.push({ on: 'core', cmd: 'show spanning-tree root' });
    s.push({ on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'show spanning-tree summary' });
    s.push({ on: 'sw2', cmd: 'show spanning-tree root' });

    s.push({ section: 'host verification' });
    for (const on of ['l1', 'l2', 'srv1', 'srv2']) {
      s.push({ on, cmd: 'ip -br addr' });
    }
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.13' });
    s.push({ on: 'sw1', cmd: 'show running-config' });

    await dumpL2('cisco-l2-04-spanning-tree', topology, s,
      'focus=PVST/RPVST/MST modes, root/priority, portfast/guards, MST region, topology change');
  }, 180000);
});
