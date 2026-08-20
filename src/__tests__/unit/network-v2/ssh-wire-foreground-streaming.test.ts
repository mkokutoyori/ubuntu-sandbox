import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');
const CLIENT_IP = '192.168.9.10';
const SERVER_IP = '192.168.9.20';

const key = (k: string, ctrl = false) =>
  ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as never;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A ping reply lands once a second, so a window of a few hundred
 * milliseconds cannot tell a stream from a single batch. These waits are
 * sized against that interval on purpose.
 */
const REPLY_INTERVAL_MS = 1000;

async function sshedIn(): Promise<LinuxTerminalSession> {
  const client = new LinuxPC('linux-pc', 'CLI1');
  const server = new LinuxServer('linux-server', 'SRV1');
  client.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('c1').connect(client.getPorts()[0], server.getPorts()[0]);

  const term = new LinuxTerminalSession('t1', client);
  await term.init?.();
  term.setInput(`ssh alice@${SERVER_IP}`);
  term.handleKey(key('Enter'));
  for (let i = 0; i < 20 && term.currentInputMode.type !== 'password'; i++) await wait(25);
  term.setPasswordBuf('alice');
  term.handleKey(key('Enter'));
  for (let i = 0; i < 20; i++) await wait(25);
  expect(term.foreground.getPrompt(), 'the session must be up for this to measure anything').toMatch(/alice@/);
  return term;
}

const replyCount = (term: LinuxTerminalSession) =>
  term.lines.filter((l) => /bytes from/.test(l.text)).length;

describe('a foreground job on the remote streams over the channel', () => {
  it('ping replies arrive one at a time, not as one batch at the end', async () => {
    const term = await sshedIn();
    term.setInputBuf(`ping ${CLIENT_IP}`);
    term.handleKey(key('Enter'));

    await wait(REPLY_INTERVAL_MS * 0.5);
    const early = replyCount(term);
    await wait(REPLY_INTERVAL_MS * 2.5);
    const later = replyCount(term);

    expect(early, 'the first reply shows before the command could have finished').toBeGreaterThan(0);
    expect(
      later,
      'more replies after waiting longer is what makes it a stream rather than a batch',
    ).toBeGreaterThan(early);
  }, 40000);

  it('Ctrl+C stops it, and nothing arrives afterwards', async () => {
    const term = await sshedIn();
    term.setInputBuf(`ping ${CLIENT_IP}`);
    term.handleKey(key('Enter'));
    await wait(REPLY_INTERVAL_MS * 2.5);
    expect(replyCount(term)).toBeGreaterThan(0);

    term.handleKey(key('c', true));
    await wait(200);
    const atInterrupt = replyCount(term);

    await wait(REPLY_INTERVAL_MS * 2);
    expect(
      replyCount(term),
      'the job runs on the remote, so the interrupt has to reach it — a local-only Ctrl+C would leave it running',
    ).toBe(atInterrupt);
  }, 40000);
});
