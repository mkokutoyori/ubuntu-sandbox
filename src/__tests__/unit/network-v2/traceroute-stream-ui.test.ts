import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

function buildTwoHopLinux(): LinuxPC {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const src = new LinuxPC('linux-pc', 'PC1');

  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  pc2.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.3.1'));
  src.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  src.setDefaultGateway(new IPAddress('10.0.1.1'));

  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

  new Cable('cSrcR1').connect(src.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('cR1R2').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('cR2PC2').connect(r2.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);

  src.powerOn();
  return src;
}

describe('Linux traceroute — hop-by-hop streaming on the async pipeline', () => {
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('engages the streaming job synchronously, emits the header asynchronously, renders every hop, then unlocks', async () => {
    const src = buildTwoHopLinux();
    const session = new LinuxTerminalSession('term-1', src);

    session.setInput('traceroute 10.0.3.2');
    session.handleKey(key('Enter'));

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);
    expect(texts(session).some((t) => t.startsWith('traceroute to'))).toBe(false);

    await waitFor(session, (l) => l.some((t) => t.startsWith('traceroute to 10.0.3.2')));
    await waitFor(session, (l) => l.some((t) => /^ 3 /.test(t) && t.includes('10.0.3.2')));
    await waitFor(session, () => !session.hasForegroundAsyncJob);

    const out = texts(session);
    expect(out.some((t) => t.startsWith('traceroute to 10.0.3.2'))).toBe(true);
    expect(out.some((t) => /^ 1 /.test(t) && t.includes('10.0.1.1'))).toBe(true);
    expect(out.some((t) => /^ 2 /.test(t) && t.includes('10.0.2.2'))).toBe(true);
    expect(out.some((t) => /^ 3 /.test(t) && t.includes('10.0.3.2'))).toBe(true);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('Ctrl+C interrupts the trace, prints ^C and frees the prompt', async () => {
    const src = buildTwoHopLinux();
    const session = new LinuxTerminalSession('term-1', src);

    session.setInput('traceroute -m 30 10.0.3.2');
    session.handleKey(key('Enter'));

    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();

    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
    expect(session.listAttachedStreams().length).toBe(0);
  });
});
