import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function setupLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const aaa = new CiscoRouter('AAA');
  nas.setEventBus(bus); aaa.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, aaa.getPort('GigabitEthernet0/0')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  aaa.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

  nas.getCoaListener().setEnabled(true);
  nas.getCoaListener().setSharedSecret('shared');
  aaa.getCoaClient().addNas('10.0.0.1', 'shared', { timeoutMs: 200, retransmit: 0 });

  return { nas, aaa };
}

describe('RADIUS Dynamic Authorization (RFC 5176) — Disconnect-Request', () => {
  it('closes a matching SSH session and ACKs', async () => {
    const bus = new EventBus();
    const { nas, aaa } = setupLab(bus);
    nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });

    const result = await aaa.getCoaClient().disconnect('10.0.0.1', { username: 'alice' });
    expect(result.kind).toBe('ack');
    expect(nas.getSshSessionRegistry().list().every((s) => s.state === 'closed')).toBe(true);
  });

  it('NAKs with session-context-not-found when no session matches', async () => {
    const bus = new EventBus();
    const { aaa } = setupLab(bus);

    const result = await aaa.getCoaClient().disconnect('10.0.0.1', { username: 'ghost' });
    expect(result.kind).toBe('nak');
    if (result.kind === 'nak') expect(result.errorCause).toBe('session-context-not-found');
  });

  it('NAKs with missing-attribute when no session identifier is supplied', async () => {
    const bus = new EventBus();
    const { nas, aaa } = setupLab(bus);
    nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });

    const result = await aaa.getCoaClient().disconnect('10.0.0.1', {});
    expect(result.kind).toBe('nak');
    if (result.kind === 'nak') expect(result.errorCause).toBe('missing-attribute');
  });

  it('times out (no reply) when the shared secret does not match', async () => {
    const bus = new EventBus();
    const { nas, aaa } = setupLab(bus);
    nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });
    aaa.getCoaClient().addNas('10.0.0.1', 'wrong-secret', { timeoutMs: 50, retransmit: 0 });

    const result = await aaa.getCoaClient().disconnect('10.0.0.1', { username: 'alice' });
    expect(result.kind).toBe('timeout');
    // The session must survive an unauthenticated disconnect attempt.
    expect(nas.getSshSessionRegistry().list().some((s) => s.user === 'alice' && s.state !== 'closed')).toBe(true);
  });

  it('publishes radius.coa.received on the NAS and radius.coa.completed on the client', async () => {
    const bus = new EventBus();
    const { nas, aaa } = setupLab(bus);
    nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });

    const received: Array<{ code: string; accepted: boolean }> = [];
    bus.subscribe('radius.coa.received', (e) => received.push(e.payload as { code: string; accepted: boolean }));
    const completed: Array<{ result: string }> = [];
    bus.subscribe('radius.coa.completed', (e) => completed.push(e.payload as { result: string }));

    await aaa.getCoaClient().disconnect('10.0.0.1', { username: 'alice' });

    expect(received.map((r) => ({ code: r.code, accepted: r.accepted }))).toEqual([{ code: 'disconnect-request', accepted: true }]);
    expect(completed.map((c) => ({ result: c.result }))).toEqual([{ result: 'ack' }]);
  });
});

describe('RADIUS Dynamic Authorization (RFC 5176) — CoA-Request', () => {
  it('ACKs a re-authorization for an existing session', async () => {
    const bus = new EventBus();
    const { nas, aaa } = setupLab(bus);
    nas.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.50' });

    const result = await aaa.getCoaClient().coaRequest('10.0.0.1', { username: 'alice' }, []);
    expect(result.kind).toBe('ack');
    // CoA re-authorizes in place — the session must still be open afterwards.
    expect(nas.getSshSessionRegistry().list().some((s) => s.user === 'alice' && s.state !== 'closed')).toBe(true);
  });

  it('NAKs a re-authorization for an unknown session', async () => {
    const bus = new EventBus();
    const { aaa } = setupLab(bus);

    const result = await aaa.getCoaClient().coaRequest('10.0.0.1', { username: 'ghost' }, []);
    expect(result.kind).toBe('nak');
    if (result.kind === 'nak') expect(result.errorCause).toBe('session-context-not-found');
  });
});
