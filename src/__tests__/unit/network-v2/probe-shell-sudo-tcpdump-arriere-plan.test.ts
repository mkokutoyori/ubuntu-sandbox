/**
 * `sudo tcpdump -w FILE -c N &` returns to the prompt at once, as a shell does for any background job (the capture waits for traffic,
 * so it can only finish later). Measured before the change: the interactive path awaited the job's network work, so the command never
 * returned until N frames had crossed the wire (a terminal that stays blocked forever on a quiet link).
 * 2 cases fall before: the immediate return and the capture finished by a later ping. The WITNESS (`sleep 1 &` returns at once) and the
 * foreground capture pass either way: they prove the lab and the race helper are sound.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { installVirtualClock } from '../../support/ntpTime';

const NEVER = Symbol('still running');

async function returnsWithin(promise: Promise<string>, ms: number): Promise<string | typeof NEVER> {
  return Promise.race([promise, new Promise<typeof NEVER>((resolve) => setTimeout(() => resolve(NEVER), ms))]);
}

function lab(): { listener: LinuxPC; sender: LinuxPC } {
  installVirtualClock();
  const listener = new LinuxPC('PC1', 0, 0);
  const sender = new LinuxPC('PC2', 100, 0);
  new Cable('c1').connect(listener.getPort('eth0')!, sender.getPort('eth0')!);
  return { listener, sender };
}

async function quiet(): Promise<{ listener: LinuxPC; sender: LinuxPC }> {
  installVirtualClock();
  const listener = new LinuxPC('PC1', 0, 0);
  const sender = new LinuxPC('PC2', 100, 0);
  await listener.executeCommand('ifconfig eth0 10.9.0.1 netmask 255.255.255.0');
  new Cable('c1').connect(listener.getPort('eth0')!, sender.getPort('eth0')!);
  return { listener, sender };
}

async function addressed(): Promise<{ listener: LinuxPC; sender: LinuxPC }> {
  const { listener, sender } = await quiet();
  await sender.executeCommand('ifconfig eth0 10.9.0.2 netmask 255.255.255.0');
  return { listener, sender };
}

describe('sudo tcpdump … & returns at once', () => {
  it('WITNESS: sleep 1 & returns at once', async () => {
    const { listener } = await addressed();
    const result = await returnsWithin(listener.executeCommand('sleep 1 &'), 1000);
    expect(result).toMatch(/^\[1\] \d+/);
  });

  it('returns the job number and pid without waiting for the traffic', async () => {
    const { listener } = await quiet();
    const result = await returnsWithin(listener.executeCommand('sudo tcpdump -w /tmp/b.cap -c 1 &'), 1500);
    expect(result).not.toBe(NEVER);
    expect(result).toMatch(/^\[1\] \d+/);
  });

  it('the capture finishes when a later ping crosses the wire and the file holds the frame', async () => {
    const { listener, sender } = await quiet();
    const started = await returnsWithin(listener.executeCommand('sudo tcpdump -w /tmp/c.cap -c 1 &'), 1500);
    expect(started).not.toBe(NEVER);
    await sender.executeCommand('ifconfig eth0 10.9.0.2 netmask 255.255.255.0');
    await sender.executeCommand('ping -c 1 10.9.0.1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const read = await listener.executeCommand('tcpdump -nn -r /tmp/c.cap');
    expect(read).toMatch(/\d\d:\d\d:\d\d\.\d+ /);
  });

  it('WITNESS: the foreground capture ends when the traffic arrives', async () => {
    const { listener, sender } = await addressed();
    const running = listener.executeCommand('sudo tcpdump -nn -c 1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await sender.executeCommand('ping -c 1 10.9.0.1');
    const output = await returnsWithin(running, 3000);
    expect(output).not.toBe(NEVER);
  });
});
