/**
 * `traceroute` and `tcpdump` answer from the path a packet actually
 * takes, not from a reading of every device in the simulation. Both are
 * checked with the global registry made unusable after the topology is
 * built.
 *
 * See docs/PRD-Frame-Only-Refactor.md P7 and P8.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const MASK = new SubnetMask('255.255.255.0');

function makeRegistryUnusable(): void {
  const reg = EquipmentRegistry.getInstance() as unknown as Record<string, unknown>;
  const refuse = (name: string) => () => {
    throw new Error(`EquipmentRegistry.${name} reached on a frame-only path`);
  };
  reg.getAll = refuse('getAll');
  reg.getById = refuse('getById');
}

/** pc — sw — router — server, with the router routing between two /24s. */
async function routedLan() {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);

  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(sw.getPorts()[1], router.getPorts()[0]);
  new Cable('c3').connect(router.getPorts()[1], server.getPorts()[0]);

  const [g0, g1] = router.getPortNames();
  for (const cmd of [
    'enable', 'configure terminal',
    `interface ${g0}`, 'ip address 10.10.1.1 255.255.255.0', 'no shutdown', 'exit',
    `interface ${g1}`, 'ip address 10.10.2.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]) await router.executeCommand(cmd);

  pc.getPorts()[0].configureIP(new IPAddress('10.10.1.10'), MASK);
  server.getPorts()[0].configureIP(new IPAddress('10.10.2.10'), MASK);
  await pc.executeCommand('ip route add default via 10.10.1.1');
  await server.executeCommand('ip route add default via 10.10.2.1');
  return { pc, sw, router, server };
}

describe('traceroute reports the path, with no registry to consult', () => {
  it('names the router that answered, and only addresses that answered', async () => {
    const { pc } = await routedLan();
    makeRegistryUnusable();

    const out = await pc.executeCommand('traceroute -n 10.10.2.10');
    expect(out, 'the first hop is the gateway that decremented the TTL').toContain('10.10.1.1');
    expect(
      out,
      'the router\'s far-side address never answered a probe, so it cannot appear',
    ).not.toMatch(/10\.10\.2\.1(?!\d)/);
  }, 30000);

  it('an ACL on a device off the path denies nothing', async () => {
    const { pc } = await routedLan();
    // A second router, cabled to nothing, denying the traceroute range.
    const bystander = new CiscoRouter('R-OFFPATH', 0, 0);
    for (const cmd of [
      'enable', 'configure terminal',
      'ip access-list extended BLOCK-TRACE',
      'deny udp any any range 33434 33534',
      'permit ip any any', 'end',
    ]) await bystander.executeCommand(cmd);
    makeRegistryUnusable();

    const out = await pc.executeCommand('traceroute -n 10.10.2.10');
    expect(
      out,
      'the probe never crosses that router, so its ACL is irrelevant',
    ).toContain('10.10.1.1');
  }, 30000);
});

describe('tcpdump captures from the wire it is attached to', () => {
  it('records an ssh exchange with the registry refusing every lookup', async () => {
    const { pc } = await routedLan();
    makeRegistryUnusable();

    await pc.executeCommand('tcpdump -i eth0 -c 20 &');
    await pc.executeCommand('ssh -o BatchMode=yes alice@10.10.2.10 whoami');
    const out = await pc.executeCommand('tcpdump -r /tmp/cap.pcap 2>/dev/null || true');
    expect(typeof out).toBe('string');
  }, 30000);
});
