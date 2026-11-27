/*
 * Probe: CoA and Disconnect over IPv6 (RFC 5176 does not restrict the transport; FreeRADIUS v3.2.x radclient accepts an IPv6 server for coa and disconnect).
 * radclient could only reach a NAS by IPv4: the dynamic authorization client sent through the IPv4 egress only and the NAS listener of the Cisco and Huawei
 * routers read UDP/3799 on the IPv4 path only (the router IPv6 local UDP delivery handed the datagram to the generic endpoint, which has no CoA listener). The
 * client now sends through the host's family-aware datagram sender and the listener is offered every IPv6 datagram the router delivers locally; the verdict
 * (session closed, Error-Cause, bad secret dropped) is the one the IPv4 path already gives, through the same listener.
 *
 * Discriminated with git stash on src/network: 4 of 5 fall before the fix; the IPv4 witness (same lab, same session registry) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });


function lab6() {
  const bus = new EventBus();
  const nas = new CiscoRouter('NAS');
  const aaa = new LinuxServer('linux-server', 'AAA');
  nas.setEventBus(bus); aaa.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, aaa.getPort('eth0')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  aaa.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nas.enableIPv6Routing();
  nas.configureIPv6Interface('GigabitEthernet0/0', new IPv6Address('fd00::1'), 64);
  aaa.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  nas.getCoaListener().setEnabled(true);
  nas.getCoaListener().setSharedSecret('shared');
  nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });
  return { nas, aaa };
}

async function status6(server: LinuxServer, command: string) {
  await server.executeCommand('ping -6 -c 1 fd00::1');
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const ALICE6 = `printf 'User-Name = "alice"\\n'`;

describe('radclient coa and disconnect over IPv6', () => {
  it('witness: the same lab answers a disconnect over IPv4', async () => {
    const { nas, aaa } = lab6();
    const result = await status6(aaa, `${ALICE6} | radclient 10.0.0.1 disconnect shared`);
    expect(result.code).toBe('0');
    expect(nas.getSshSessionRegistry().list().every((session) => session.state === 'closed')).toBe(true);
  });

  it('disconnect to the IPv6 address of the NAS closes the session and is acknowledged', async () => {
    const { nas, aaa } = lab6();
    const result = await status6(aaa, `${ALICE6} | radclient fd00::1 disconnect shared`);
    expect(result.output).toMatch(/Sent Disconnect-Request Id \d+ from :::\d+ to fd00::1:3799/);
    expect(result.output).toMatch(/Received Disconnect-ACK Id \d+ from fd00::1:3799/);
    expect(result.code).toBe('0');
    expect(nas.getSshSessionRegistry().list().every((session) => session.state === 'closed')).toBe(true);
  });

  it('coa over IPv6 is acknowledged and the session stays open', async () => {
    const { nas, aaa } = lab6();
    const result = await status6(aaa, `${ALICE6} | radclient fd00::1 coa shared`);
    expect(result.output).toMatch(/Received CoA-ACK Id \d+/);
    expect(result.code).toBe('0');
    expect(nas.getSshSessionRegistry().list().some((session) => session.user === 'alice' && session.state !== 'closed')).toBe(true);
  });

  it('an unknown user over IPv6 is NAKed with its Error-Cause', async () => {
    const { aaa } = lab6();
    const result = await status6(aaa, `printf 'User-Name = "ghost"\\n' | radclient -x fd00::1 disconnect shared`);
    expect(result.output).toContain('\tError-Cause = Session-Context-Not-Found');
    expect(result.code).toBe('1');
  });

  it('a wrong secret over IPv6 gets no reply and leaves the session open', async () => {
    const { nas, aaa } = lab6();
    const result = await status6(aaa, `${ALICE6} | radclient -t 1 -r 1 fd00::1 disconnect wrong`);
    expect(result.output).toMatch(/No reply from server for ID \d+/);
    expect(result.code).toBe('1');
    expect(nas.getSshSessionRegistry().list().some((session) => session.user === 'alice' && session.state !== 'closed')).toBe(true);
  });
});
