import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import { IPAddress, MACAddress } from '@/network/core/types';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Cisco debug arp — event subscription streams ARP frames into the terminal', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: CiscoRouter;
  let session: CiscoTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    router = new CiscoRouter('R1');
    router.setEventBus(bus);
    const sid = manager.openTerminal(router)!;
    session = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(session);
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  function arpFrame(op: 'request' | 'reply', senderIp: string, senderMac: string, targetIp: string, targetMac: string) {
    return {
      etherType: 0x0806,
      payload: {
        type: 'arp',
        operation: op,
        senderIP: new IPAddress(senderIp),
        senderMAC: new MACAddress(senderMac),
        targetIP: new IPAddress(targetIp),
        targetMAC: new MACAddress(targetMac),
      },
    };
  }

  function rcvdRequest(): void {
    bus.publish({
      topic: 'port.frame.received',
      payload: {
        deviceId: router.getId(),
        portName: 'GigabitEthernet0/0',
        frame: arpFrame('request', '10.0.0.2', '00:11:22:33:44:55', '10.0.0.1', '00:00:00:00:00:00'),
      },
    });
  }

  function sentReply(): void {
    bus.publish({
      topic: 'port.frame.tx-requested',
      payload: {
        deviceId: router.getId(),
        portName: 'GigabitEthernet0/0',
        frame: arpFrame('reply', '10.0.0.1', 'aa:bb:cc:00:01:00', '10.0.0.2', '00:11:22:33:44:55'),
      },
    });
  }

  it('streams a live rcvd req line once debug arp is enabled', async () => {
    await router.executeCommandInVty('enable', session.vty!);
    await type('debug arp');

    expect(session.hasBackgroundAsyncJobs).toBe(true);
    expect(session.listAsyncJobs().some((j) => j.kind === 'subscription')).toBe(true);

    rcvdRequest();
    await flush();

    expect(session.lines.some((l) =>
      l.text.includes('IP ARP: rcvd req') &&
      l.text.includes('src 10.0.0.2 00:11:22:33:44:55') &&
      l.text.includes('dst 10.0.0.1') &&
      l.text.includes('GigabitEthernet0/0'))).toBe(true);
  });

  it('streams sent rep for an outgoing ARP reply', async () => {
    await router.executeCommandInVty('enable', session.vty!);
    await type('debug arp');

    sentReply();
    await flush();

    expect(session.lines.some((l) =>
      l.text.includes('IP ARP: sent rep') &&
      l.text.includes('src 10.0.0.1 aa:bb:cc:00:01:00'))).toBe(true);
  });

  it('the prompt stays free while debug arp runs (background, not blocking)', async () => {
    await router.executeCommandInVty('enable', session.vty!);
    await type('debug arp');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('no debug arp stops the subscription — further frames are silent', async () => {
    await router.executeCommandInVty('enable', session.vty!);
    await type('debug arp');
    rcvdRequest();
    await flush();
    const count = session.lines.filter((l) => l.text.includes('IP ARP:')).length;
    expect(count).toBe(1);

    await type('no debug arp');
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    rcvdRequest();
    await flush();
    expect(session.lines.filter((l) => l.text.includes('IP ARP:')).length).toBe(count);
  });

  it('sessions are isolated — a second terminal without debug sees nothing', async () => {
    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as CiscoTerminalSession;
    await waitBoot(session2);

    await router.executeCommandInVty('enable', session.vty!);
    await type('debug arp');
    rcvdRequest();
    await flush();

    expect(session.lines.some((l) => l.text.includes('IP ARP:'))).toBe(true);
    expect(session2.lines.some((l) => l.text.includes('IP ARP:'))).toBe(false);
  });
});
