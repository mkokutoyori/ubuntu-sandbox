/*
 * In the terminal of PC-CONSEILLER, 'ping web.banquehorizon.com' answered (203.0.113.20) while 'ssh bob@web.banquehorizon.com' died with
 * 'ssh: Could not resolve hostname web.banquehorizon.com: Name or service not known'. The terminal's ssh resolved the name with a private function
 * (resolveSshHost: a hand-written read of /etc/hosts, matching even the SHORT first label of the typed name, then a topology lookup by device name) that never
 * asked the DNS, while ping and the non-interactive ssh of the same machine go through the machine's resolver (nsswitch: files then dns, over the wire).
 * resolveSshHost now delegates to LinuxMachine.resolveHostname first, the same call ping makes; the topology lookup stays as the last resort.
 *
 * Measured against the commit before (worktree): 2 of the 3 cases fall (a name only the DNS knows, and a jump host given by such a name). The WITNESS
 * passes either way: a name in /etc/hosts still resolves and the connection attempt proceeds past the name.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

async function typed(line: string): Promise<string[]> {
  await buildDnsAgenceBancaire();
  const pc = [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'PC-CONSEILLER')!;
  const session = new LinuxTerminalSession('t', pc as never);
  session.setInput(line);
  session.handleKey(key('Enter'));
  await flush();
  return session.lines.map((l) => l.text);
}

describe('the terminal ssh resolves names the way ping does', () => {
  it('WITNESS: a dotted address is not looked up and the attempt reaches the connection', async () => {
    const lines = await typed('ssh bob@203.0.113.20');
    expect(lines.join('\n')).not.toContain('Could not resolve hostname');
  });

  it('a name only the DNS knows resolves: no "Could not resolve hostname"', async () => {
    const lines = await typed('ssh bob@web.banquehorizon.com');
    expect(lines.join('\n')).not.toContain('Could not resolve hostname');
  });

  it('a jump host given by a DNS name resolves too', async () => {
    const lines = await typed('ssh -J bob@web.banquehorizon.com bob@203.0.113.10');
    expect(lines.join('\n')).not.toContain('Could not resolve hostname');
  });
});
