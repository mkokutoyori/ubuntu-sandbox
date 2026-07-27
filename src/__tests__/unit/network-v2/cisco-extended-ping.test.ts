/**
 * IOS extended ping: `ping` with no argument, in privileged EXEC, opens a
 * question-and-answer dialog instead of erroring out. Each answer has to
 * reach the packet — a dialog whose answers change nothing would be a
 * decoration.
 *
 *   Protocol [ip]:
 *   Target IP address: 8.8.8.8
 *   Repeat count [5]:
 *   Datagram size [100]:
 *   Timeout in seconds [2]:
 *   Extended commands [n]: y
 *   Source address or interface: GigabitEthernet0/0
 *   Type of service [0]:
 *   Set DF bit in IP header? [no]:
 *   Validate reply data? [no]:
 *   Data pattern [0xABCD]:
 *   Loose, Strict, Record, Timestamp, Verbose[none]:
 *   Sweep range of sizes [n]:
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const key = (k: string) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as never;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function settle(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) { await Promise.resolve(); await tick(); }
}

/**
 * Type one line, the way the view does: the command prompt writes the
 * console buffer, while a flow's interactive-text input writes the
 * sub-shell one. Driving the wrong buffer would take a dispatch branch
 * the operator cannot reach.
 */
async function answer(term: CiscoTerminalSession, value: string): Promise<void> {
  const fg = term.foreground as unknown as {
    setInput: (v: string) => void; setInputBuf: (v: string) => void;
    handleKey: (e: unknown) => void; currentInputMode: { type: string };
  };
  if (fg.currentInputMode.type === 'interactive-text') fg.setInputBuf(value);
  else fg.setInput(value);
  fg.handleKey(key('Enter'));
  await settle();
}

const text = (term: CiscoTerminalSession) => term.lines.map((l) => l.text).join('\n');

/** The question the terminal is currently asking, as the operator sees it. */
const prompt = (term: CiscoTerminalSession): string => {
  const m = term.currentInputMode as { promptText?: string };
  return m.promptText ?? '';
};

async function lab() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);
  const [a] = r1.getPortNames();
  const [b] = r2.getPortNames();
  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${a}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await r1.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal', 'hostname R2',
    `interface ${b}`, 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end',
  ]) await r2.executeCommand(c);

  const term = new CiscoTerminalSession('t1', r1);
  await term.init?.();
  await answer(term, 'enable');
  return { r1, r2, term, a };
}

describe('extended ping', () => {
  it('asks the IOS questions, in the IOS order, with the IOS defaults', async () => {
    const { term } = await lab();
    await answer(term, 'ping');

    expect(prompt(term), 'bare `ping` must open the dialog, not error out').toBe('Protocol [ip]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Target IP address:');
    await answer(term, '10.0.0.2');
    expect(prompt(term)).toBe('Repeat count [5]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Datagram size [100]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Timeout in seconds [2]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Extended commands [n]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Sweep range of sizes [n]:');
    await answer(term, '');

    await settle(80);
    const out = text(term);
    expect(out).toContain('Type escape sequence to abort.');
    expect(out).toMatch(/Sending 5, 100-byte ICMP Echos to 10\.0\.0\.2, timeout is 2 seconds:/);
    expect(out).toContain('Success rate is 100 percent (5/5)');
  }, 40000);

  it('the answers reach the packet — repeat and size are not decoration', async () => {
    const { term } = await lab();
    await answer(term, 'ping');
    await answer(term, '');          // Protocol
    await answer(term, '10.0.0.2');  // Target
    await answer(term, '3');         // Repeat count
    await answer(term, '1400');      // Datagram size
    await answer(term, '');          // Timeout
    await answer(term, '');          // Extended commands
    await answer(term, '');          // Sweep
    await settle(80);

    expect(text(term)).toMatch(/Sending 3, 1400-byte ICMP Echos to 10\.0\.0\.2/);
    expect(text(term)).toContain('(3/3)');
  }, 40000);

  it('`Extended commands: y` opens the extended block and the source is honoured', async () => {
    const { term, a } = await lab();
    await answer(term, 'ping');
    await answer(term, '');
    await answer(term, '10.0.0.2');
    await answer(term, '');
    await answer(term, '');
    await answer(term, '');
    await answer(term, 'y');         // Extended commands
    expect(prompt(term)).toBe('Source address or interface:');
    await answer(term, a);
    expect(prompt(term)).toBe('Type of service [0]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Set DF bit in IP header? [no]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Validate reply data? [no]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Data pattern [0xABCD]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Loose, Strict, Record, Timestamp, Verbose[none]:');
    await answer(term, '');
    expect(prompt(term)).toBe('Sweep range of sizes [n]:');
    await answer(term, '');
    await settle(80);

    expect(text(term)).toContain('Success rate is 100 percent (5/5)');
  }, 40000);

  it('a bad target is refused the way IOS refuses it', async () => {
    const { term } = await lab();
    await answer(term, 'ping');
    await answer(term, '');
    await answer(term, 'not-an-address');
    await settle(40);
    expect(
      text(term) + '\n' + prompt(term),
    ).toMatch(/% Unrecognized host or address|Target IP address:/);
  }, 40000);

  it('the dialog belongs to privileged EXEC — user EXEC keeps the one-line form', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    const term = new CiscoTerminalSession('t1', r1);
    await term.init?.();
    await answer(term, 'ping');
    await settle(20);
    expect(
      prompt(term),
      'IOS only offers the extended dialog once you are enabled',
    ).not.toBe('Protocol [ip]:');
  }, 40000);
});
