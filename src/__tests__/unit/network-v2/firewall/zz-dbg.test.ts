import { describe, it } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function run(sh: FortiShell, ...l: string[]): string { let x=''; for (const c of l) x = sh.execute(c); return x; }

describe('dbg', () => {
  it('sdwan', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const sh = new FortiShell(fw);
    run(sh, 'config system interface',
      'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
      'edit "port3"', 'set mode static', 'set ip 198.51.100.1 255.255.255.0', 'next', 'end');
    console.log('DBG out:', JSON.stringify(run(sh,
      'config system sdwan', 'set status enable',
      'config members', 'edit 1', 'set interface "port2"', 'set gateway 203.0.113.254', 'set priority 1', 'next',
      'edit 2', 'set interface "port3"', 'set gateway 198.51.100.254', 'set priority 2', 'next', 'end',
      'config health-check', 'edit "vers_internet"', 'set server "203.0.113.254"',
      'set protocol ping', 'set members 1 2',
      'config sla', 'edit 1', 'set packetloss-threshold 2', 'next', 'end',
      'next', 'end', 'end')));
    const t = fw.getSdwan().getTable();
    console.log('DBG enabled:', t.isEnabled());
    console.log('DBG members:', JSON.stringify(t.allMembers()));
    console.log('DBG checks:', JSON.stringify(t.allHealthChecks()));
    console.log('DBG show:', JSON.stringify(sh.execute('show system sdwan')));
  });
});
