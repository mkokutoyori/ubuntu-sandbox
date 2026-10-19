/**
 * Extended authentication (XAUTH) of an Easy VPN client against a RADIUS or TACACS+ server
 * (`aaa authentication login LIST group ...`, `crypto map TAG client authentication list LIST`).
 * The IKE responder cannot answer before the AAA server has: it tells the initiator it is
 * working (a `processing` message), waits for the verdict that crosses the wire, and only then
 * sends the accept or the reject; the initiator keeps its negotiation open meanwhile. An
 * initiator that gets no such message still fails at once, as before.
 *
 * Lab: HUB (EzVPN server) - CLIENT (+PC), and HUB - AAA on a second subnet. The tap on the AAA
 * router counts the requests that reach UDP/1812 (RADIUS) or TCP/49 (TACACS+).
 *
 * Measured with src stashed to HEAD: 3 of the 8 cases fall (the RADIUS accept, the RADIUS refusal that must have reached the
 * server, and the TACACS+ accept). Five pass either way: the local witness, the TACACS+ refusal, the two silent-server
 * cases and the unanswered responder, which are refusals before the change for want of any decision; each is paired
 * with an accept that falls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { run, ezvpnClientLab as lab, configureClient, assignInterfaces as assign, type EzvpnClientLab } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

interface AaaLab extends EzvpnClientLab { aaa: CiscoRouter; requests: { count: number } }

async function aaaLab(serverUp = true): Promise<AaaLab> {
  const l = await lab();
  const aaa = new CiscoRouter('AAA');
  new Cable('aaa').connect(l.hub.getPort('GigabitEthernet0/2')!, aaa.getPort('GigabitEthernet0/0')!);
  await run(l.hub, ['interface GigabitEthernet0/2', 'ip address 10.7.0.1 255.255.255.252', 'no shutdown', 'exit']);
  await run(aaa, ['interface GigabitEthernet0/0', 'ip address 10.7.0.2 255.255.255.252', 'no shutdown', 'exit']);
  const radius = aaa.getRadiusServer();
  radius.start();
  radius.setSharedSecret('secret');
  radius.authorizeClient('10.7.0.1');
  radius.addUser('carol', 'carolpw');
  radius.setEnabled(serverUp);
  const tacacs = aaa.getTacacsServer();
  tacacs.setEnabled(serverUp);
  tacacs.setSharedSecret('secret');
  tacacs.addUser('carol', 'carolpw');
  l.hub.getRadiusClient().start();
  const requests = { count: 0 };
  aaa.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    if (direction !== 'in') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const l4 = packet?.type === 'ipv4' ? packet.payload as { type?: string; destinationPort?: number; flags?: unknown } : undefined;
    if ((l4?.type === 'udp' && l4.destinationPort === 1812) || (l4?.type === 'tcp' && l4.destinationPort === 49)) requests.count++;
  });
  return { ...l, aaa, requests };
}

const radiusList = ['radius-server host 10.7.0.2 auth-port 1812 key secret', 'radius-server timeout 1', 'radius-server retransmit 0',
  'aaa group server radius RG', 'server name 10.7.0.2', 'exit', 'aaa authentication login XAUTHR group RG',
  'crypto map CMAP client authentication list XAUTHR'];
const tacacsList = ['tacacs server TAC', 'address ipv4 10.7.0.2', 'key secret', 'exit', 'aaa group server tacacs+ TG', 'server name TAC', 'exit',
  'aaa authentication login XAUTHT group TG', 'crypto map CMAP client authentication list XAUTHT'];
const status = (l: EzvpnClientLab) => l.client.executeCommand('show crypto ipsec client ezvpn');
const NEM = 'mode network-extension';

async function connectAs(l: AaaLab, user: string, password: string): Promise<string> {
  await run(l.client, [...configureClient([NEM, `username ${user} password 0 ${password}`]), ...assign]);
  await clock.advance(1000);
  return status(l);
}

describe('EzVPN extended authentication through RADIUS and TACACS+', () => {
  it('witness (passes either way): a local list still authenticates the client', async () => {
    const l = await aaaLab();
    await run(l.hub, ['aaa authentication login XL local', 'username alice secret alicepw', 'crypto map CMAP client authentication list XL']);
    expect(await connectAs(l, 'alice', 'alicepw')).toContain('IPSEC_ACTIVE');
  });

  it('RADIUS: the accepted user gets a tunnel, after a request that crossed the wire', async () => {
    const l = await aaaLab();
    await run(l.hub, radiusList);
    expect(await connectAs(l, 'carol', 'carolpw')).toContain('IPSEC_ACTIVE');
    expect(l.requests.count).toBeGreaterThan(0);
  });

  it('RADIUS: a wrong password is refused by the server and the client has no tunnel', async () => {
    const l = await aaaLab();
    await run(l.hub, radiusList);
    expect(await connectAs(l, 'carol', 'wrong')).not.toContain('IPSEC_ACTIVE');
    expect(l.requests.count).toBeGreaterThan(0);
  });

  it('TACACS+: the accepted user gets a tunnel, after a request that crossed the wire', async () => {
    const l = await aaaLab();
    await run(l.hub, tacacsList);
    expect(await connectAs(l, 'carol', 'carolpw')).toContain('IPSEC_ACTIVE');
    expect(l.requests.count).toBeGreaterThan(0);
  });

  it('TACACS+: a wrong password is refused', async () => {
    const l = await aaaLab();
    await run(l.hub, tacacsList);
    expect(await connectAs(l, 'carol', 'wrong')).not.toContain('IPSEC_ACTIVE');
  });

  it('a silent RADIUS server falls through to the next method of the list (local)', async () => {
    const l = await aaaLab(false);
    await run(l.hub, ['radius-server host 10.7.0.2 auth-port 1812 key secret', 'radius-server timeout 1', 'radius-server retransmit 0',
      'aaa group server radius RG', 'server name 10.7.0.2', 'exit', 'aaa authentication login XAUTHR group RG local',
      'username alice secret alicepw', 'crypto map CMAP client authentication list XAUTHR']);
    await clock.advanceUntilSettled(run(l.client, [...configureClient([NEM, 'username alice password 0 alicepw']), ...assign]));
    expect(await status(l)).toContain('IPSEC_ACTIVE');
  });

  it('a silent RADIUS server with no fallback leaves the client without a tunnel', async () => {
    const l = await aaaLab(false);
    await run(l.hub, radiusList);
    await clock.advanceUntilSettled(run(l.client, [...configureClient([NEM, 'username carol password 0 carolpw']), ...assign]));
    expect(await status(l)).not.toContain('IPSEC_ACTIVE');
  });

  it('a responder that does not answer at all still fails at once (no processing message)', async () => {
    const l = await aaaLab();
    await run(l.hub, ['no crypto isakmp enable']);
    await run(l.client, [...configureClient([NEM]), ...assign]);
    expect(await status(l)).toContain('Current State: IDLE');
    expect(await status(l)).toContain('Last Event: SOCKET_DOWN');
  });
});
