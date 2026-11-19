/*
 * Probe: radclient could not send a CoA-Request or a Disconnect-Request, so a Linux host could not play the dynamic authorization
 * client of RFC 5176 although the NAS side (CoaListener on the Cisco router) answers. Source of truth: FreeRADIUS v3.2.x radclient.c
 * (radclient_get_port: Disconnect-Request and CoA-Request default to UDP 3799; the Sent/Received header lines; the expected code of
 * coa is CoA-ACK and of disconnect Disconnect-ACK, so a NAK prints "Expected ... got ..." and exits 1), lib/radius.c
 * (fr_packet_codes: "Disconnect-Request", "Disconnect-ACK", "Disconnect-NAK", "CoA-Request", "CoA-ACK", "CoA-NAK"), share/
 * dictionary.rfc3576 and rfc5176 (the Error-Cause value names).
 *
 * Discriminated with git stash on src/network: 6 of 6 fall before the fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

function lab() {
  const bus = new EventBus();
  const nas = new CiscoRouter('NAS');
  const aaa = new LinuxServer('linux-server', 'AAA');
  nas.setEventBus(bus); aaa.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, aaa.getPort('eth0')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  aaa.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nas.getCoaListener().setEnabled(true);
  nas.getCoaListener().setSharedSecret('shared');
  nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });
  return { nas, aaa };
}

async function status(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const ALICE = `printf 'User-Name = "alice"\\n'`;

describe('radclient coa and disconnect', () => {
  it('disconnect closes the session and prints Sent / Received in the radclient notation, exit 0', async () => {
    const { nas, aaa } = lab();
    const result = await status(aaa, `${ALICE} | radclient 10.0.0.1 disconnect shared`);
    expect(result.output).toMatch(/^Sent Disconnect-Request Id \d+ from 0\.0\.0\.0:\d+ to 10\.0\.0\.1:3799 length \d+\nReceived Disconnect-ACK Id \d+ from 10\.0\.0\.1:3799 to 10\.0\.0\.2:\d+ length \d+$/);
    expect(result.code).toBe('0');
    expect(nas.getSshSessionRegistry().list().every((session) => session.state === 'closed')).toBe(true);
  });

  it('disconnect of an unknown user is NAKed with Error-Cause, and radclient says what it expected, exit 1', async () => {
    const { aaa } = lab();
    const result = await status(aaa, `printf 'User-Name = "ghost"\\n' | radclient -x 10.0.0.1 disconnect shared`);
    expect(result.output).toContain('Received Disconnect-NAK');
    expect(result.output).toContain('\tError-Cause = Session-Context-Not-Found');
    expect(result.output).toContain('(0) -: Expected Disconnect-ACK got Disconnect-NAK');
    expect(result.code).toBe('1');
  });

  it('a request with no session identifier is NAKed as Missing-Attribute', async () => {
    const { aaa } = lab();
    const result = await status(aaa, `printf 'Reply-Message = "x"\\n' | radclient -x 10.0.0.1 disconnect shared`);
    expect(result.output).toContain('\tError-Cause = Missing-Attribute');
  });

  it('coa re-authorizes in place: CoA-ACK and the session stays open', async () => {
    const { nas, aaa } = lab();
    const result = await status(aaa, `${ALICE} | radclient 10.0.0.1 coa shared`);
    expect(result.output).toMatch(/Sent CoA-Request Id \d+ from 0\.0\.0\.0:\d+ to 10\.0\.0\.1:3799/);
    expect(result.output).toMatch(/Received CoA-ACK Id \d+/);
    expect(result.code).toBe('0');
    expect(nas.getSshSessionRegistry().list().some((session) => session.user === 'alice' && session.state !== 'closed')).toBe(true);
  });

  it('coa for an unknown session is a CoA-NAK, exit 1', async () => {
    const { aaa } = lab();
    const result = await status(aaa, `printf 'User-Name = "ghost"\\n' | radclient 10.0.0.1 coa shared`);
    expect(result.output).toContain('(0) -: Expected CoA-ACK got CoA-NAK');
    expect(result.code).toBe('1');
  });

  it('a wrong secret gets no reply: the loss is reported, exit 1', async () => {
    const { aaa } = lab();
    const result = await status(aaa, `${ALICE} | radclient -t 1 -r 1 10.0.0.1 disconnect wrong`);
    expect(result.output).toMatch(/\(0\) No reply from server for ID \d+ socket 3/);
    expect(result.code).toBe('1');
  });
});
