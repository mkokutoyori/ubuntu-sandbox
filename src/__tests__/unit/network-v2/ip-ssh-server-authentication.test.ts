/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `ip ssh server algorithm
 * authentication {publickey | keyboard | password}`, `ip ssh server authenticate user {publickey |
 * keyboard | password}`, `ip ssh server algorithm publickey {x509v3-ssh-rsa | ssh-rsa}`.
 *
 * Book: the IOS SSH server offers publickey, keyboard-interactive and password in that order by
 * default; `no` removes a method; a command that would remove the last one is rejected with
 * `% SSH command rejected: All <family> algorithms cannot be disabled`.
 *
 * Lab: a Linux client and a Cisco router on one switch. The client is told which method to try
 * (`-o PreferredAuthentications=...`), so a refusal means the router did not offer or accept that
 * method on the wire, not that the command failed to parse.
 *
 * Measured with src stashed to HEAD: the commands were refused and the router never offered
 * keyboard-interactive, so 11 of the 15 cases fall. Four pass either way: the password witness,
 * `no ... keyboard` (keyboard-interactive was not offered anyway, the others still work), the wrong
 * password and the refusal of an unknown method.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { interoperateWithIos15 } from './iosLegacySsh';

const PASSWORD = 'Admin@2025';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

interface Lab {
  router: CiscoRouter;
  configure(...lines: string[]): Promise<string[]>;
  ssh(method: 'password' | 'keyboard-interactive' | 'publickey'): Promise<string>;
}

async function lab(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const router = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(router.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  for (const c of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.6 255.255.255.0', 'no shutdown', 'exit',
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', `username admin privilege 15 secret ${PASSWORD}`,
    'line vty 0 4', 'login local', 'transport input ssh', 'end',
  ]) await router.executeCommand(c);
  await interoperateWithIos15(router);
  await interoperateWithIos15(pc);
  await pc.executeCommand('ssh-keygen -t rsa -b 2048 -N "" -f ~/.ssh/id_rsa');
  const body = (await pc.executeCommand('cat ~/.ssh/id_rsa.pub')).trim().split(/\s+/)[1];
  for (const line of ['configure terminal', 'ip ssh pubkey-chain', 'username admin', 'key-string',
    ...(body.match(/.{1,64}/g) ?? []), 'exit', 'exit', 'exit', 'end']) await router.executeCommand(line);
  return {
    router,
    async configure(...lines: string[]) {
      const answers: string[] = [];
      for (const line of ['configure terminal', ...lines, 'end']) answers.push(await router.executeCommand(line));
      return answers;
    },
    ssh: (method) => pc.executeCommand(
      `ssh -i ~/.ssh/id_rsa -o PreferredAuthentications=${method} -o StrictHostKeyChecking=no admin@10.0.0.6 "show clock"`,
      `${PASSWORD}\n`),
  };
}

const worked = (output: string): boolean => /\d\d:\d\d:\d\d/.test(output);

describe('ip ssh server algorithm authentication', () => {
  it('witness (passes either way): by default the password login works', async () => {
    const l = await lab();
    expect(worked(await l.ssh('password'))).toBe(true);
  });

  it('by default keyboard-interactive is offered and works', async () => {
    const l = await lab();
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(true);
  });

  it('removing keyboard leaves password and publickey', async () => {
    const l = await lab();
    await l.configure('no ip ssh server algorithm authentication keyboard');
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(false);
    expect(worked(await l.ssh('password'))).toBe(true);
    expect(worked(await l.ssh('publickey'))).toBe(true);
  });

  it('removing password leaves keyboard and publickey', async () => {
    const l = await lab();
    await l.configure('no ip ssh server algorithm authentication password');
    expect(worked(await l.ssh('password'))).toBe(false);
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(true);
  });

  it('removing publickey closes the key door', async () => {
    const l = await lab();
    expect(worked(await l.ssh('publickey'))).toBe(true);
    await l.configure('no ip ssh server algorithm authentication publickey');
    expect(worked(await l.ssh('publickey'))).toBe(false);
    expect(worked(await l.ssh('password'))).toBe(true);
  });

  it('an explicit list offers exactly those methods', async () => {
    const l = await lab();
    await l.configure('ip ssh server algorithm authentication password');
    expect(worked(await l.ssh('password'))).toBe(true);
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(false);
    expect(worked(await l.ssh('publickey'))).toBe(false);
  });

  it('the last method cannot be removed', async () => {
    const l = await lab();
    const answers = await l.configure('ip ssh server algorithm authentication password',
      'no ip ssh server algorithm authentication password');
    expect(answers.join('\n')).toContain('% SSH command rejected: All authentication algorithms cannot be disabled');
    expect(worked(await l.ssh('password'))).toBe(true);
  });

  it('a wrong password is still refused through keyboard-interactive', async () => {
    const l = await lab();
    await l.configure('username admin privilege 15 secret Other@2025');
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(false);
  });

  it('the list is rendered in the running-config and the default restores everything', async () => {
    const l = await lab();
    await l.configure('ip ssh server algorithm authentication publickey password');
    expect(await l.router.executeCommand('show running-config')).toContain('ip ssh server algorithm authentication publickey password');
    await l.configure('no ip ssh server algorithm authentication');
    expect(await l.router.executeCommand('show running-config')).not.toContain('ip ssh server algorithm authentication');
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(true);
  });
});

describe('ip ssh server authenticate user', () => {
  it('no ... keyboard closes keyboard-interactive and ... keyboard opens it again', async () => {
    const l = await lab();
    await l.configure('no ip ssh server authenticate user keyboard');
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(false);
    await l.configure('ip ssh server authenticate user keyboard');
    expect(worked(await l.ssh('keyboard-interactive'))).toBe(true);
  });

  it('shares its list with the algorithm command: one fact, one writing', async () => {
    const l = await lab();
    await l.configure('no ip ssh server authenticate user password');
    expect(await l.router.executeCommand('show running-config')).toContain('ip ssh server algorithm authentication publickey keyboard');
  });

  it('refuses an unknown method', async () => {
    const l = await lab();
    const answers = await l.configure('ip ssh server authenticate user zorglub');
    expect(answers.join('\n')).toContain('% Invalid input');
  });
});

describe('ip ssh server algorithm publickey', () => {
  it('witness (passes either way): both algorithms are accepted as a list', async () => {
    const l = await lab();
    const answers = await l.configure('ip ssh server algorithm publickey x509v3-ssh-rsa ssh-rsa');
    expect(answers.join('\n')).not.toContain('% Invalid');
  });

  it('removing ssh-rsa leaves no algorithm the router can verify, so key logins fail', async () => {
    const l = await lab();
    await l.configure('no ip ssh server algorithm publickey ssh-rsa');
    expect(worked(await l.ssh('publickey'))).toBe(false);
    expect(worked(await l.ssh('password'))).toBe(true);
  });

  it('the last algorithm cannot be removed', async () => {
    const l = await lab();
    const answers = await l.configure('ip ssh server algorithm publickey ssh-rsa', 'no ip ssh server algorithm publickey ssh-rsa');
    expect(answers.join('\n')).toContain('% SSH command rejected: All publickey algorithms cannot be disabled');
  });
});
