/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `radius-server attribute 4
 * <address>`, `attribute 6 {on-for-login-auth | mandatory | support-multiple}`, `attribute 32
 * include-in-access-req [format <string>]`, `attribute 55 include-in-acct-req`.
 *
 * Book: attribute 4 replaces the NAS-IP-Address inside the packet only; Service-Type is not sent in
 * login authentication requests unless on-for-login-auth, `mandatory` makes an Access-Accept without
 * it a failed authentication, and several Service-Type attributes in one Access-Accept are treated as
 * an Access-Reject unless support-multiple; attribute 32 carries the FQDN by default or the format with
 * %i (address), %h (hostname) and %d (domain name); attribute 55 is the time of the event in seconds.
 *
 * Lab: radiusLab (NAS + a live RADIUS server on one switch). A tap on the server's port decodes the
 * requests that arrive, so every case compares the attribute that crossed the wire with the command.
 *
 * Measured with src stashed to HEAD: `radius-server attribute` was refused, so 10 of the 14 cases fall.
 * Four pass either way: the defaults witness, the accept without Service-Type under the default policy,
 * the accept that carries Service-Type under `mandatory`, and the refusal of malformed values.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { attr, getAttr, type RadiusPacket } from '@/network/radius/types';
import { radiusLab, radiusLogin } from './_helpers/radiusAaaLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

function capture(server: CiscoRouter): RadiusPacket[] {
  const seen: RadiusPacket[] = [];
  server.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }) => {
    if (direction !== 'in') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const udp = packet?.type === 'ipv4' ? packet.payload as UDPPacket : undefined;
    if (udp?.type === 'udp' && (udp.destinationPort === 1812 || udp.destinationPort === 1813)) seen.push(udp.payload as RadiusPacket);
  });
  return seen;
}

const requests = (seen: RadiusPacket[]): RadiusPacket[] => seen.filter((p) => p.code === 'access-request');

describe('RADIUS attributes in the access request', () => {
  it('witness (passes either way): by default the request carries the interface address and neither Service-Type nor NAS-Identifier', async () => {
    const { nas, live } = await radiusLab([]);
    const seen = capture(live);
    expect(await radiusLogin(clock, nas)).toBe(true);
    const request = requests(seen)[0];
    expect(getAttr(request, 'nas-ip-address')?.value).toBe('10.0.0.1');
    expect(getAttr(request, 'service-type')).toBeUndefined();
    expect(getAttr(request, 'nas-identifier')).toBeUndefined();
  });

  it('attribute 4 replaces the NAS-IP-Address inside the packet', async () => {
    const { nas, live } = await radiusLab(['radius-server attribute 4 192.0.2.77']);
    const seen = capture(live);
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(getAttr(requests(seen)[0], 'nas-ip-address')?.value).toBe('192.0.2.77');
  });

  it('attribute 6 on-for-login-auth sends Service-Type Login', async () => {
    const { nas, live } = await radiusLab(['radius-server attribute 6 on-for-login-auth']);
    const seen = capture(live);
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(getAttr(requests(seen)[0], 'service-type')?.value).toBe(1);
  });

  it('attribute 32 sends the hostname by default and the domain name when there is one', async () => {
    const { nas, live } = await radiusLab(['radius-server attribute 32 include-in-access-req']);
    const seen = capture(live);
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(getAttr(requests(seen)[0], 'nas-identifier')?.value).toBe('NAS');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('ip domain name lab.test');
    await nas.executeCommand('end');
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(getAttr(requests(seen)[1], 'nas-identifier')?.value).toBe('NAS.lab.test');
  });

  it('attribute 32 with a format expands %h, %d and %i as the book example does', async () => {
    const { nas, live } = await radiusLab(['ip domain name nlab.test', 'radius-server attribute 32 include-in-access-req format cisco %h.%d %i']);
    const seen = capture(live);
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(getAttr(requests(seen)[0], 'nas-identifier')?.value).toBe('cisco NAS.nlab.test 10.0.0.1');
  });
});

describe('Service-Type in the access accept', () => {
  it('witness (passes either way): an accept without Service-Type is accepted by default', async () => {
    const { nas } = await radiusLab([]);
    expect(await radiusLogin(clock, nas)).toBe(true);
  });

  it('mandatory turns an accept without Service-Type into a failed authentication', async () => {
    const { nas } = await radiusLab(['radius-server attribute 6 mandatory']);
    expect(await radiusLogin(clock, nas)).toBe(false);
  });

  it('mandatory lets an accept that carries Service-Type through', async () => {
    const { nas, live } = await radiusLab(['radius-server attribute 6 mandatory']);
    live.getRadiusServer().addUser('alice', 'pw', [attr('service-type', 6)]);
    expect(await radiusLogin(clock, nas)).toBe(true);
  });

  it('two Service-Type attributes are an Access-Reject unless support-multiple', async () => {
    const lab = await radiusLab([]);
    lab.live.getRadiusServer().addUser('alice', 'pw', [attr('service-type', 6), attr('service-type', 7)]);
    expect(await radiusLogin(clock, lab.nas)).toBe(false);
    await lab.nas.executeCommand('configure terminal');
    await lab.nas.executeCommand('radius-server attribute 6 support-multiple');
    await lab.nas.executeCommand('end');
    expect(await radiusLogin(clock, lab.nas)).toBe(true);
  });
});

describe('RADIUS attributes in accounting requests', () => {
  async function accountingAttributes(lines: string[]): Promise<RadiusPacket> {
    const { nas, live } = await radiusLab(lines);
    const seen = capture(live);
    const accounting = nas.getRadiusAccountingClient();
    accounting.start();
    accounting.addServer('10.0.0.3', 'secret', { timeoutMs: 200, retransmit: 0 });
    accounting.setAttributePolicy(nas.getAaaAuthenticator().radiusAttributePolicy());
    accounting.startSession('alice', '10.0.0.3');
    await clock.advanceUntilSettled(Promise.resolve());
    return seen.find((p) => p.code === 'accounting-request') as RadiusPacket;
  }

  it('witness (passes either way): no Event-Timestamp by default', async () => {
    expect(getAttr(await accountingAttributes([]), 'event-timestamp')).toBeUndefined();
  });

  it('attribute 55 puts the time of the event, in seconds, in the request', async () => {
    const request = await accountingAttributes(['radius-server attribute 55 include-in-acct-req']);
    const stamp = Number(getAttr(request, 'event-timestamp')?.value);
    expect(Math.abs(stamp - Math.floor(Date.now() / 1000))).toBeLessThan(86_400 * 365 * 40);
    expect(stamp).toBeGreaterThan(1_000_000_000);
  });

  it('attribute 32 and attribute 4 also apply to accounting requests', async () => {
    const request = await accountingAttributes(['radius-server attribute 4 192.0.2.9', 'radius-server attribute 32 include-in-access-req']);
    expect(getAttr(request, 'nas-ip-address')?.value).toBe('192.0.2.9');
    expect(getAttr(request, 'nas-identifier')?.value).toBe('NAS');
  });
});

describe('configuration', () => {
  it('every form is rendered in the running-config and cleared by its no form', async () => {
    const { nas } = await radiusLab([
      'radius-server attribute 4 192.0.2.77', 'radius-server attribute 6 on-for-login-auth', 'radius-server attribute 6 mandatory',
      'radius-server attribute 6 support-multiple', 'radius-server attribute 32 include-in-access-req format cisco %h.%d %i',
      'radius-server attribute 55 include-in-acct-req',
    ]);
    const running = await nas.executeCommand('show running-config');
    for (const line of ['radius-server attribute 4 192.0.2.77', 'radius-server attribute 6 on-for-login-auth', 'radius-server attribute 6 mandatory',
      'radius-server attribute 6 support-multiple', 'radius-server attribute 32 include-in-access-req format cisco %h.%d %i',
      'radius-server attribute 55 include-in-acct-req']) expect(running).toContain(line);
    await nas.executeCommand('configure terminal');
    for (const line of ['radius-server attribute 4', 'radius-server attribute 6 on-for-login-auth', 'radius-server attribute 6 mandatory',
      'radius-server attribute 6 support-multiple', 'radius-server attribute 32 include-in-access-req', 'radius-server attribute 55 include-in-acct-req']) {
      await nas.executeCommand(`no ${line}`);
    }
    await nas.executeCommand('end');
    expect(await nas.executeCommand('show running-config')).not.toContain('radius-server attribute');
  });

  it('refuses a malformed address and an unknown Service-Type keyword', async () => {
    const { nas } = await radiusLab([]);
    await nas.executeCommand('configure terminal');
    expect(await nas.executeCommand('radius-server attribute 4 999.1.1.1')).toContain('% Invalid input');
    expect(await nas.executeCommand('radius-server attribute 6 zorglub')).toContain('% Invalid input');
  });
});
