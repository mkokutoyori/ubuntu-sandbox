/**
 * Huawei `display ikev2 sa` was a hardcoded stub (`() => 'Info: No IKEv2 SAs.'`)
 * that ignored the real engine entirely, unlike the correctly-wired
 * `display ike v2 sa` a few lines below it in the same file. This test builds
 * a genuine GRE-over-IPsec (tunnel protection) IKEv2 site-to-site tunnel
 * between two Huawei routers and drives real traffic through it, so both
 * display forms must report the same live SA.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function configureEndpoint(
  router: HuaweiRouter,
  side: { wanIp: string; peerWan: string; lanIp: string; remoteSubnet: string; tunIp: string },
  psk: string,
): Promise<void> {
  for (const cmd of [
    'system-view',
    'interface GE0/0/1', `ip address ${side.wanIp} 255.255.255.252`, 'undo shutdown', 'quit',
    'interface GE0/0/0', `ip address ${side.lanIp} 255.255.255.0`, 'undo shutdown', 'quit',

    'interface Tunnel0',
    `ip address ${side.tunIp} 255.255.255.252`,
    'tunnel-protocol gre',
    'source GE0/0/1',
    `destination ${side.peerWan}`,
    'quit',

    'ike v2 proposal PROP1', 'encryption-algorithm aes-cbc-256', 'integrity-algorithm sha2-256', 'dh group14', 'quit',
    'ike v2 policy POL1', 'proposal PROP1', 'quit',
    'ike v2 keyring KR1', 'peer PEER', `address ${side.peerWan}`, `pre-shared-key simple ${psk}`, 'quit', 'quit',
    'ike v2 profile PROF1',
    'match remote identity any',
    'authentication-method local pre-share',
    'authentication-method remote pre-share',
    'keyring KR1',
    'quit',

    'ipsec proposal TSET', 'esp encryption-algorithm aes-256', 'esp authentication-algorithm sha2-256', 'quit',
    'ipsec profile GRE_PROF', 'proposal TSET', 'quit',

    'interface Tunnel0', 'ipsec profile GRE_PROF', 'quit',

    `ip route-static ${side.remoteSubnet} 255.255.255.0 172.16.0.2`,
  ]) await router.executeCommand(cmd);
}

async function buildLab() {
  const r1 = new HuaweiRouter('R1');
  const r2 = new HuaweiRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('wan').connect(r1.getPort('GE0/0/1')!, r2.getPort('GE0/0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GE0/0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GE0/0/0')!);

  const psk = 'HuaweiIKEv2GreSecret';
  await configureEndpoint(r1, { wanIp: '10.0.12.1', peerWan: '10.0.12.2', lanIp: '192.168.1.1', remoteSubnet: '192.168.2.0', tunIp: '172.16.0.1' }, psk);
  await configureEndpoint(r2, { wanIp: '10.0.12.2', peerWan: '10.0.12.1', lanIp: '192.168.2.1', remoteSubnet: '192.168.1.0', tunIp: '172.16.0.2' }, psk);

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2 };
}

describe('Huawei display ikev2 sa — wired to the real engine (was a hardcoded stub)', () => {
  it('before any traffic: both display forms agree there is no SA', async () => {
    const { r1 } = await buildLab();
    const legacy = await r1.executeCommand('display ikev2 sa');
    const real = await r1.executeCommand('display ike v2 sa');
    expect(legacy).toMatch(/no ikev2 sa/i);
    expect(real).toMatch(/no ikev2 sa/i);
  });

  it('after a real GRE-over-IPsec IKEv2 tunnel is established, display ikev2 sa reports the live SA identically to display ike v2 sa', async () => {
    const { r1, pc1 } = await buildLab();
    const ping = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(ping).toContain('3 received');

    const legacy = await r1.executeCommand('display ikev2 sa');
    const real = await r1.executeCommand('display ike v2 sa');
    expect(legacy).toContain('10.0.12.1');
    expect(legacy).toContain('10.0.12.2');
    expect(legacy).toMatch(/READY/);
    expect(legacy).toBe(real);
  });
});
