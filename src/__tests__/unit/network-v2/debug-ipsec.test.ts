import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('Debug', () => {
  it('dynamic crypto map debug', { timeout: 15000 }, async () => {
    const hub = new CiscoRouter('HUB');
    const spoke1 = new CiscoRouter('SPOKE1');
    const pcHub = new LinuxPC('linux-pc', 'PC_HUB');
    const pcSpk1 = new LinuxPC('linux-pc', 'PC_SPK1');

    new Cable('hub-spk1').connect(hub.getPort('GigabitEthernet0/1')!, spoke1.getPort('GigabitEthernet0/1')!);
    new Cable('hub-pc').connect(pcHub.getPort('eth0')!, hub.getPort('GigabitEthernet0/0')!);
    new Cable('spk1-pc').connect(pcSpk1.getPort('eth0')!, spoke1.getPort('GigabitEthernet0/0')!);

    // HUB config
    await hub.executeCommand('enable');
    await hub.executeCommand('configure terminal');
    await hub.executeCommand('interface GigabitEthernet0/1');
    await hub.executeCommand('ip address 10.0.12.1 255.255.255.252');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/0');
    await hub.executeCommand('ip address 10.1.0.1 255.255.255.0');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');
    await hub.executeCommand('crypto isakmp policy 10');
    await hub.executeCommand('encryption aes 256');
    await hub.executeCommand('hash sha256');
    await hub.executeCommand('authentication pre-share');
    await hub.executeCommand('group 14');
    await hub.executeCommand('exit');
    await hub.executeCommand('crypto isakmp key HubSpokeKey address 0.0.0.0 0.0.0.0');
    await hub.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await hub.executeCommand('mode tunnel');
    await hub.executeCommand('exit');
    await hub.executeCommand('crypto dynamic-map DMAP 10');
    await hub.executeCommand('set transform-set TSET');
    await hub.executeCommand('exit');
    await hub.executeCommand('crypto map CMAP 65535 ipsec-isakmp dynamic DMAP');
    await hub.executeCommand('interface GigabitEthernet0/1');
    await hub.executeCommand('crypto map CMAP');
    await hub.executeCommand('exit');
    await hub.executeCommand('ip route 192.168.10.0 255.255.255.0 10.0.12.2');
    await hub.executeCommand('end');

    // SPOKE1 config (same as before)
    await spoke1.executeCommand('enable');
    await spoke1.executeCommand('configure terminal');
    await spoke1.executeCommand('interface GigabitEthernet0/1');
    await spoke1.executeCommand('ip address 10.0.12.2 255.255.255.252');
    await spoke1.executeCommand('no shutdown');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('interface GigabitEthernet0/0');
    await spoke1.executeCommand('ip address 192.168.10.1 255.255.255.0');
    await spoke1.executeCommand('no shutdown');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('crypto isakmp policy 10');
    await spoke1.executeCommand('encryption aes 256');
    await spoke1.executeCommand('hash sha256');
    await spoke1.executeCommand('authentication pre-share');
    await spoke1.executeCommand('group 14');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('crypto isakmp key HubSpokeKey address 10.0.12.1');
    await spoke1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await spoke1.executeCommand('mode tunnel');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('ip access-list extended VPN_ACL');
    await spoke1.executeCommand('permit ip 192.168.10.0 0.0.0.255 10.1.0.0 0.0.0.255');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await spoke1.executeCommand('set peer 10.0.12.1');
    await spoke1.executeCommand('set transform-set TSET');
    await spoke1.executeCommand('match address VPN_ACL');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('interface GigabitEthernet0/1');
    await spoke1.executeCommand('crypto map CMAP');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('ip route 10.1.0.0 255.255.255.0 10.0.12.1');
    await spoke1.executeCommand('end');

    await pcHub.executeCommand('sudo ip addr add 10.1.0.10/24 dev eth0');
    await pcHub.executeCommand('sudo ip route add default via 10.1.0.1');
    await pcSpk1.executeCommand('sudo ip addr add 192.168.10.10/24 dev eth0');
    await pcSpk1.executeCommand('sudo ip route add default via 192.168.10.1');

    // Ping
    const ping1 = await pcSpk1.executeCommand('ping -c 1 10.1.0.10');
    console.log('PING result:', ping1);

    // Check both sides' SAs
    const spoke1SA = await spoke1.executeCommand('show crypto ipsec sa');
    console.log('SPOKE1 IPSec SA encaps/decaps:');
    const lines = spoke1SA.split('\n');
    for (const l of lines) {
      if (l.includes('encaps') || l.includes('decaps') || l.includes('error') || l.includes('peer')) {
        console.log('  ', l.trim());
      }
    }
    
    const hubSA = await hub.executeCommand('show crypto ipsec sa');
    console.log('HUB IPSec SA encaps/decaps:');
    const hlines = hubSA.split('\n');
    for (const l of hlines) {
      if (l.includes('encaps') || l.includes('decaps') || l.includes('error') || l.includes('peer')) {
        console.log('  ', l.trim());
      }
    }

    const hubCounters = await hub.executeCommand('show counters');
    console.log('HUB counters:', hubCounters);

    expect(true).toBe(true); // Just for debug
  });
});
