import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-06-port-security-access', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline security state', cmd: 'enable' });
    for (const c of [
      'show port-security', 'show port-security address', 'show errdisable recovery',
      'show ip dhcp snooping', 'show ip dhcp snooping binding',
      'show ip arp inspection', 'show dot1x', 'show dot1x all',
      'show storm-control', 'show storm-control broadcast',
    ]) s.push(c);

    s.push({ section: 'port-security config loop (Fa0/1..0/20)', cmd: 'configure terminal' });
    for (let i = 1; i <= 20; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('switchport mode access');
      s.push('switchport port-security');
      s.push(`switchport port-security maximum ${1 + (i % 3)}`);
      s.push(`switchport port-security violation ${['shutdown', 'restrict', 'protect'][i % 3]}`);
      s.push('switchport port-security mac-address sticky');
      s.push('switchport port-security aging time 5');
      s.push('switchport port-security aging type inactivity');
      s.push('exit');
    }
    s.push('end');
    s.push('show port-security');

    s.push({ section: 'static secure MAC entries', cmd: 'configure terminal' });
    s.push('interface FastEthernet0/2');
    s.push('switchport port-security mac-address 0000.1111.2222');
    s.push('switchport port-security mac-address 0000.1111.3333');
    s.push('exit');
    s.push('end');
    s.push('show port-security address');
    s.push('show port-security interface FastEthernet0/2');

    s.push({ section: 'errdisable recovery', cmd: 'configure terminal' });
    s.push('errdisable recovery cause psecure-violation');
    s.push('errdisable recovery cause bpduguard');
    s.push('errdisable recovery cause arp-inspection');
    s.push('errdisable recovery interval 60');
    s.push('do show errdisable recovery');
    s.push('end');

    s.push({ section: 'trigger port-security violation (L1 traffic on a max-1 sticky port)', on: 'sw1', cmd: 'show port-security interface FastEthernet0/1' });
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.13' });
    s.push({ on: 'sw1', cmd: 'show port-security interface FastEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'show port-security address' });
    s.push({ on: 'sw1', cmd: 'show mac address-table secure' });
    s.push({ on: 'sw1', cmd: 'show interfaces status err-disabled' });

    s.push({ section: '802.1X (dot1x) configuration', cmd: 'configure terminal' });
    s.push('aaa new-model');
    s.push('aaa authentication dot1x default group radius');
    s.push('dot1x system-auth-control');
    s.push('do show dot1x');
    for (let i = 1; i <= 8; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('dot1x pae authenticator');
      s.push('dot1x port-control auto');
      s.push('dot1x host-mode single-host');
      s.push('dot1x reauthentication');
      s.push('dot1x timeout quiet-period 60');
      s.push('exit');
    }
    s.push('end');
    s.push('show dot1x all');
    s.push('show dot1x interface FastEthernet0/1');

    s.push({ section: 'DHCP snooping', cmd: 'configure terminal' });
    s.push('ip dhcp snooping');
    s.push('ip dhcp snooping vlan 1,10,20');
    s.push('ip dhcp snooping information option');
    s.push('interface GigabitEthernet0/1');
    s.push('ip dhcp snooping trust');
    s.push('exit');
    s.push('interface FastEthernet0/1');
    s.push('ip dhcp snooping limit rate 15');
    s.push('exit');
    s.push('do show ip dhcp snooping');
    s.push('end');
    s.push('show ip dhcp snooping binding');

    s.push({ section: 'Dynamic ARP Inspection', cmd: 'configure terminal' });
    s.push('ip arp inspection vlan 1,10,20');
    s.push('ip arp inspection validate src-mac dst-mac ip');
    s.push('arp access-list TRUST-HOSTS');
    s.push('permit ip host 192.168.1.13 mac host 0000.aaaa.bbbb');
    s.push('exit');
    s.push('ip arp inspection filter TRUST-HOSTS vlan 1');
    s.push('interface GigabitEthernet0/1');
    s.push('ip arp inspection trust');
    s.push('exit');
    s.push('interface FastEthernet0/1');
    s.push('ip arp inspection limit rate 15');
    s.push('exit');
    s.push('do show ip arp inspection');
    s.push('do show ip arp inspection vlan 1');
    s.push('end');

    s.push({ section: 'storm-control loop (Fa0/1..0/12)', cmd: 'configure terminal' });
    for (let i = 1; i <= 12; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('storm-control broadcast level 20.00');
      s.push('storm-control multicast level 30.00');
      s.push('storm-control unicast level pps 1000');
      s.push('storm-control action shutdown');
      s.push('exit');
    }
    s.push('end');
    s.push('show storm-control');
    s.push('show storm-control broadcast');

    s.push({ section: 'per-interface port-security inspection loop' });
    for (let i = 1; i <= 20; i++) {
      s.push(`show port-security interface FastEthernet0/${i}`);
    }

    s.push({ section: 'DAI generates traffic (host ARP)', on: 'l1', cmd: 'ping -c 2 192.168.1.13' });
    s.push({ on: 'srv1', cmd: 'arp -n' });
    s.push({ on: 'sw1', cmd: 'show ip arp inspection statistics' });
    s.push({ on: 'sw1', cmd: 'show ip dhcp snooping binding' });

    s.push({ section: 'host verification' });
    for (const on of ['l1', 'srv1', 'l2', 'srv2']) {
      s.push({ on, cmd: 'ip -br addr' });
      s.push({ on, cmd: 'arp -n' });
    }
    s.push({ on: 'w1', cmd: 'arp -a' });
    s.push({ on: 'w2', cmd: 'ipconfig' });
    s.push({ on: 'sw1', cmd: 'show running-config' });

    await dumpL2('cisco-l2-06-port-security-access', topology, s,
      'focus=port-security/sticky/violation, errdisable, dot1x, DHCP snooping, DAI, storm-control');
  }, 180000);
});
