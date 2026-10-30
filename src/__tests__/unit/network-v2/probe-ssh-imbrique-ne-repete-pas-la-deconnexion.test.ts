/**
 * A nested `ssh` refused with MaxAuthTries prints its two disconnect lines ONCE.
 *
 * Measured before the fix: `Received disconnect from … Too many authentication
 * failures` and `Disconnected from …` appeared twice. The password answer travels
 * through `provideInput`, whose reply is printed by the sub-shell, while the same
 * bytes reach the channel's data listener, which prints "unsolicited" output. The
 * listener is muted while a command is in flight, but `handleInput` did not mark
 * itself in flight.
 *
 * Discriminated with `git stash push -- src/terminal/subshells`: 1 of 2 cases
 * falls before the fix. The other is the WITNESS: the first hop's own output
 * ("Permanently added") is printed once either way, so the lab prints at all.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const wait = (ms = 300) => new Promise<void>((r) => setTimeout(r, ms));

async function nestedRefusal(): Promise<string> {
  EquipmentRegistry.resetInstance();
  const a = new LinuxPC('linux-pc', 'PC1');
  const b = new LinuxPC('linux-pc', 'PC2');
  a.powerOn(); b.powerOn();
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  new Cable('c').connect(a.getPorts()[0], b.getPorts()[0]);
  const vfs = (a as unknown as { executor: { vfs: { readFile(p: string): string | null; writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  const current = vfs.readFile('/etc/ssh/sshd_config') ?? '';
  vfs.writeFile('/etc/ssh/sshd_config', /^MaxAuthTries\b.*$/m.test(current)
    ? current.replace(/^MaxAuthTries\b.*$/m, 'MaxAuthTries 1') : `${current}\nMaxAuthTries 1\n`, 0, 0, 0o022);
  await a.executeCommand('systemctl restart ssh');
  const term = new LinuxTerminalSession('t', a);
  const line = async (text: string) => { term.setInput(text); term.setInputBuf(text); term.handleKey(key('Enter')); await wait(600); };
  const password = async (text: string) => { term.setPasswordBuf(text); term.handleKey(key('Enter')); await wait(800); };
  await line('ssh user@10.0.0.2');
  if (term.currentInputMode.type !== 'password') await line('yes');
  await password('admin');
  const mark = term.lines.length;
  await line('ssh user@10.0.0.1');
  if (term.currentInputMode.type !== 'password') await line('yes');
  await password('wrong');
  return term.lines.slice(mark).map((l) => l.text).join('\n');
}

describe('nested ssh refused by MaxAuthTries 1', () => {
  it('prints the disconnect pair once', async () => {
    const out = await nestedRefusal();
    expect(out.match(/Received disconnect from/g) ?? []).toHaveLength(1);
    expect(out.match(/Disconnected from/g) ?? []).toHaveLength(1);
  }, 60_000);

  it('WITNESS: the host-key line is printed once', async () => {
    const out = await nestedRefusal();
    expect(out.match(/Permanently added/g) ?? []).toHaveLength(1);
  }, 60_000);
});
