import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { RadiusAccountingRecordPayload } from '@/network/radius/events';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function setupLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  const cableA = new Cable('a');
  cableA.setEventBus(bus);
  cableA.connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  const cableB = new Cable('b');
  cableB.setEventBus(bus);
  cableB.connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { nas, server, sw };
}

describe('RADIUS accounting (RFC 2866)', () => {
  it('records Start then Stop for a session and journals both', () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    nas.getRadiusAccountingClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const records: RadiusAccountingRecordPayload[] = [];
    bus.subscribe('radius.accounting.record', (e) => records.push(e.payload));

    const sessionId = nas.getRadiusAccountingClient().startSession('alice');
    expect(sessionId).not.toBeNull();
    nas.getRadiusAccountingClient().stopSession(sessionId!, 'user-request');

    expect(records.map((r) => r.status)).toEqual(['start', 'stop']);
    expect(records[0].username).toBe('alice');
    expect(records[0].sessionId).toBe(sessionId);
    expect(records[1].terminateCause).toBe('user-request');

    const journaled = server.getRadiusServer().listAccountingSessions();
    const record = journaled.find((s) => s.sessionId === sessionId);
    expect(record?.status).toBe('stop');
    expect(record?.username).toBe('alice');
  });

  it('carries cumulative octet counters through an Interim-Update', () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    nas.getRadiusAccountingClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const sessionId = nas.getRadiusAccountingClient().startSession('bob')!;
    nas.getRadiusAccountingClient().interimUpdate(sessionId, { inputOctets: 4096, outputOctets: 8192 });

    const journaled = server.getRadiusServer().listAccountingSessions().find((s) => s.sessionId === sessionId);
    expect(journaled?.status).toBe('interim-update');
    expect(journaled?.inputOctets).toBe(4096);
    expect(journaled?.outputOctets).toBe(8192);
  });

  it('rejects (silently discards, no journal entry) an Accounting-Request with the wrong shared secret', () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    nas.getRadiusAccountingClient().addServer('10.0.0.2', 'wrong-secret', { timeoutMs: 50, retransmit: 0 });

    const records: unknown[] = [];
    bus.subscribe('radius.accounting.record', (e) => records.push(e.payload));

    const sessionId = nas.getRadiusAccountingClient().startSession('carol')!;

    expect(records.length).toBe(0);
    expect(server.getRadiusServer().listAccountingSessions().some((s) => s.sessionId === sessionId)).toBe(false);
  });

  it('publishes radius.packet.sent/received for the Accounting-Request/Response exchange', () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    nas.getRadiusAccountingClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const sent: Array<{ code: string; hostname: string }> = [];
    bus.subscribe('radius.packet.sent', (e) => sent.push(e.payload as { code: string; hostname: string }));
    const received: Array<{ code: string; hostname: string }> = [];
    bus.subscribe('radius.packet.received', (e) => received.push(e.payload as { code: string; hostname: string }));

    nas.getRadiusAccountingClient().startSession('dave');

    expect(sent.some((s) => s.hostname === 'NAS' && s.code === 'accounting-request')).toBe(true);
    expect(received.some((r) => r.hostname === 'NAS' && r.code === 'accounting-response')).toBe(true);
  });
});
