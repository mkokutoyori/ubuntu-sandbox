import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, resetDeviceCounters } from '@/network';

describe('Debug DPD', () => {
  it('should clear SAs on cable disconnect', async () => {
    resetCounters();
    resetDeviceCounters();

    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const pc1 = new LinuxPC('linux-pc', 'PC1');
    const pc2 = new LinuxPC('linux-pc', 'PC2');

    const cableWAN = new Cable('wan');
    cableWAN.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

    for (const [router, outside, inside, peer, lan, lanPeer] of [
      [r1, '10.0.12.1', '192.168.1.1', '10.0.12.2', '192.168.1.0', '192.168.2.0'],
      [r2, '10.0.12.2', '192.168.2.1', '10.0.12.1', '192.168.2.0', '192.168.1.0'],
    ] as [CiscoRouter, string, string, string, string, string][]) {
      await router.executeCommand('enable');
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/1');
      await router.executeCommand('ip address ' + outside + ' 255.255.255.252');
      await router.executeCommand('no shutdown');
      await router.executeCommand('exit');
      await router.executeCommand('interface GigabitEthernet0/0');
      await router.executeCommand('ip address ' + inside + ' 255.255.255.0');
      await router.executeCommand('no shutdown');
      await router.executeCommand('exit');
      await router.executeCommand('crypto isakmp policy 10');
      await router.executeCommand('encryption aes 256');
      await router.executeCommand('hash sha256');
      await router.executeCommand('authentication pre-share');
      await router.executeCommand('group 14');
      await router.executeCommand('exit');
      await router.executeCommand('crypto isakmp key DpdSecret1 address ' + peer);
      await router.executeCommand('crypto isakmp keepalive 10 3 periodic');
      await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
      await router.executeCommand('mode tunnel');
      await router.executeCommand('exit');
      await router.executeCommand('ip access-list extended VPN_ACL');
      await router.executeCommand('permit ip ' + lan + ' 0.0.0.255 ' + lanPeer + ' 0.0.0.255');
      await router.executeCommand('exit');
      await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
      await router.executeCommand('set peer ' + peer);
      await router.executeCommand('set transform-set TSET');
      await router.executeCommand('match address VPN_ACL');
      await router.executeCommand('exit');
      await router.executeCommand('interface GigabitEthernet0/1');
      await router.executeCommand('crypto map CMAP');
      await router.executeCommand('exit');
      await router.executeCommand('ip route ' + lanPeer + ' 255.255.255.0 ' + peer);
      await router.executeCommand('end');
    }

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
    await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

    const ping1 = await pc1.executeCommand('ping -c 2 192.168.2.10');
    console.log('PING1:', ping1);

    const ikeBefore = await r1.executeCommand('show crypto isakmp sa');
    console.log('IKE BEFORE:', ikeBefore);

    const engine = (r1 as any).ipsecEngine;
    console.log('IPSec engine exists:', !!engine);
    if (engine) {
      console.log('IKE SA DB size:', engine.ikeSADB?.size);
      for (const [peerIP, sa] of engine.ikeSADB || new Map()) {
        console.log('  SA peer=' + peerIP + ', status=' + sa.status);
      }
    }

    console.log('=== Disconnecting cable... ===');
    cableWAN.disconnect();

    if (engine) {
      console.log('IKE SA DB size after disconnect:', engine.ikeSADB?.size);
    }

    const ikeAfter = await r1.executeCommand('show crypto isakmp sa');
    console.log('IKE AFTER:', ikeAfter);
  });
});
