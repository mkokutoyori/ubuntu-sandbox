/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands S to Z):
 * `tacacs-server directed-request [restricted] [no-truncate]` and `tacacs-server domain-stripping`.
 *
 *   directed-request   user@server: only `user` is sent, to that configured server; a host that
 *                      matches no configured server rejects the input; restricted forbids the
 *                      other servers; no-truncate keeps @hostname in the name that is sent
 *   domain-stripping   the domain is removed from the username before it is forwarded
 *
 * Lab: a NAS and two real TACACS+ servers on one switch, real TCP connections. Both know the user
 * `alice` only (a name carrying a domain is unknown to them), so an accepted login proves what name
 * ARRIVED; the TCP segments that reach each server's port 49 prove who was contacted.
 *
 * Measured with src stashed to HEAD: 8 of the 10 cases fall (the commands are rejected). Two pass
 * either way: the witness (without the commands the whole string is refused) and the no-truncate
 * case (the whole string is refused there too, which is the point of the option).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  IPAddress, SubnetMask, resetCounters, MACAddress, type IPv4Packet, type TCPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

function connections(device: CiscoRouter): { syns: number } {
  const seen = { syns: 0 };
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      const tcp = packet?.type === 'ipv4' ? packet.payload as TCPPacket : undefined;
      if (tcp?.type === 'tcp' && tcp.destinationPort === 49 && tcp.flags?.syn && !tcp.flags?.ack) seen.syns++;
    });
  }
  return seen;
}

async function lab(globalLines: string[]) {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const nas = new CiscoRouter('NAS');
  const down = new CiscoRouter('DOWN');
  const up = new CiscoRouter('UP');
  for (const [i, d] of [nas, down, up].entries()) {
    new Cable(`c${i}`).connect(d.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    d.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']) await d.executeCommand(c);
  }
  for (const server of [down, up]) {
    const agent = server.getTacacsServer();
    agent.setEnabled(true);
    agent.setSharedSecret('Tacacs@2025');
    agent.addUser('alice', 'pw', 15);
  }
  down.getTacacsServer().setEnabled(false);
  for (const c of [
    'enable', 'configure terminal', 'aaa new-model',
    'tacacs server T1', 'address ipv4 10.0.0.2', 'port 49', 'key Tacacs@2025', 'timeout 1', 'exit',
    'tacacs server T2', 'address ipv4 10.0.0.3', 'port 49', 'key Tacacs@2025', 'timeout 1', 'exit',
    'aaa group server tacacs+ G', 'server name T1', 'server name T2', 'exit',
    'aaa authentication login default group G',
    ...globalLines, 'end',
  ]) await nas.executeCommand(c);
  return { nas, toDown: connections(down), toUp: connections(up) };
}

async function login(nas: CiscoRouter, username: string): Promise<boolean> {
  const outcome = await clock.advanceUntilSettled(nas.getAaaAuthenticator().authenticate(username, 'pw', 'default'));
  return outcome.accepted;
}

describe('tacacs-server domain-stripping on the wire', () => {
  it('witness: without the command the whole string is sent and the user is unknown', async () => {
    const { nas } = await lab([]);
    expect(await login(nas, 'alice@corp.example')).toBe(false);
  });

  it('the domain is stripped before the username is forwarded', async () => {
    const { nas } = await lab(['tacacs-server domain-stripping']);
    expect(await login(nas, 'alice@corp.example')).toBe(true);
  });

  it('strip-suffix strips only the named suffix', async () => {
    const { nas } = await lab(['tacacs-server domain-stripping strip-suffix corp.example']);
    expect(await login(nas, 'alice@corp.example')).toBe(true);
    expect(await login(nas, 'alice@other.example')).toBe(false);
  });

  it('rules are rendered and the no form removes them', async () => {
    const { nas } = await lab(['tacacs-server domain-stripping right-to-left delimiter @$']);
    expect(await nas.executeCommand('show running-config')).toContain('tacacs-server domain-stripping right-to-left delimiter @$');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no tacacs-server domain-stripping');
    await nas.executeCommand('end');
    expect(await nas.executeCommand('show running-config')).not.toContain('tacacs-server domain-stripping');
  });
});

describe('tacacs-server directed-request on the wire', () => {
  it('the directed server is contacted first and the other one is not', async () => {
    const { nas, toDown, toUp } = await lab(['tacacs-server directed-request']);
    expect(await login(nas, 'alice@10.0.0.3')).toBe(true);
    expect(toUp.syns).toBe(1);
    expect(toDown.syns).toBe(0);
  });

  it('a host that matches no configured server rejects the input without any connection', async () => {
    const { nas, toDown, toUp } = await lab(['tacacs-server directed-request']);
    expect(await login(nas, 'alice@nowhere.example')).toBe(false);
    expect(toDown.syns + toUp.syns).toBe(0);
  });

  it('without restricted the other servers are tried when the directed one does not answer', async () => {
    const { nas, toDown, toUp } = await lab(['tacacs-server directed-request']);
    expect(await login(nas, 'alice@10.0.0.2')).toBe(true);
    expect(toDown.syns).toBeGreaterThan(0);
    expect(toUp.syns).toBe(1);
  });

  it('with restricted only the directed server is asked', async () => {
    const { nas, toDown, toUp } = await lab(['tacacs-server directed-request restricted']);
    expect(await login(nas, 'alice@10.0.0.2')).toBe(false);
    expect(toDown.syns).toBeGreaterThan(0);
    expect(toUp.syns).toBe(0);
  });

  it('no-truncate keeps @hostname in the name that is sent, so a server that knows only the bare name refuses', async () => {
    const { nas, toUp } = await lab(['tacacs-server directed-request no-truncate']);
    expect(await login(nas, 'alice@10.0.0.3')).toBe(false);
    expect(toUp.syns).toBe(1);
  });

  it('rendering and the no form', async () => {
    const { nas } = await lab(['tacacs-server directed-request restricted no-truncate']);
    expect(await nas.executeCommand('show running-config')).toContain('tacacs-server directed-request restricted no-truncate');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no tacacs-server directed-request');
    await nas.executeCommand('end');
    expect(await nas.executeCommand('show running-config')).not.toContain('tacacs-server directed-request');
  });
});
