/**
 * Probe: `ssh -A` forwards the agent as a protocol, never as a copy.
 *
 * Measured with src/network and src/terminal stashed (9 cases, 6 fall):
 * the wire exec path never consulted the agent at all, and `-A` went
 * through forwardSshAgent, which copied AgentKey records into the PEER
 * machine's SshAgent object.
 *
 *   fall before : 'witness' (a key held only by the client agent
 *                 authenticates the first hop: no agent offered on the wire)
 *   fall before : 'the signature for the second hop is made by the client agent'
 *   fall before : 'a key added from the remote lands in the client agent'
 *   fall before : 'a key removed from the remote leaves the client agent'
 *   fall before : 'the chain A -> B -> C reaches the first agent'
 *   fall before : 'agent traffic crosses the wire: -A costs more frames'
 *   pass both   : 'without -A the remote holds nothing' (non-regression)
 *   pass both   : 'the remote agent object never holds the client key'
 *                 (structural: the old copy was undone after the command, so
 *                 the invariant held at rest; the listing it makes is checked
 *                 by the chain and add/remove cases)
 *   pass both   : 'AllowAgentForwarding no refuses the request' (non-regression)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshAgent } from '@/network/protocols/ssh/SshAgent';

interface Lab {
  readonly first: LinuxPC;
  readonly second: LinuxServer;
  readonly third: LinuxServer;
  readonly agentOf: (machine: LinuxPC | LinuxServer) => SshAgent;
}

function agentOf(machine: LinuxPC | LinuxServer): SshAgent {
  const executor = (machine as unknown as { executor: {
    commandEnvironment(): Record<string, string>;
    agentProcesses: { atSocket(socket: string): { agent: SshAgent } | undefined };
  } }).executor;
  return executor.agentProcesses.atSocket(executor.commandEnvironment().SSH_AUTH_SOCK ?? '')?.agent ?? new SshAgent();
}

async function buildLab(): Promise<Lab> {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  const first = new LinuxPC('linux-pc', 'first', 0, 0);
  const second = new LinuxServer('linux-server', 'second', 0, 0);
  const third = new LinuxServer('linux-server', 'third', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [first, second, third].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  const mask = new SubnetMask('255.255.255.0');
  first.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  second.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  third.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  for (const machine of [first, second, third]) {
    const users = (machine as unknown as { executor: { userMgr: {
      useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
    } } }).executor.userMgr;
    users.useradd('alice', { m: true, s: '/bin/bash' });
    users.setPassword('alice', 'admin');
  }
  await first.executeCommand('eval $(ssh-agent -s)');
  return { first, second, third, agentOf };
}

async function authorize(machine: LinuxPC | LinuxServer, publicKey: string): Promise<void> {
  await machine.executeCommand(
    `sudo sh -c "mkdir -p /home/alice/.ssh && echo '${publicKey.trim()}' >> /home/alice/.ssh/authorized_keys && chown -R alice:alice /home/alice/.ssh && chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys"`);
}

async function loadKeyIntoClientAgent(lab: Lab): Promise<void> {
  await lab.first.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/agent_key");
}

describe('ssh -A: the agent is a protocol, not a copy', () => {
  let lab: Lab;
  beforeEach(async () => {
    lab = await buildLab();
  });

  it('witness: a key held only by the client agent authenticates the first hop', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    const pub = await lab.first.executeCommand('cat ~/.ssh/agent_key.pub');
    for (const target of [lab.second, lab.third]) await authorize(target, pub);
    const out = await lab.first.executeCommand('ssh -o PasswordAuthentication=no alice@10.0.0.2 whoami');
    expect(out.trim()).toBe('alice');
  });

  it('without -A the remote holds nothing', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    const out = await lab.first.executeCommand('ssh alice@10.0.0.2 "ssh-add -l"', 'admin\n');
    expect(out).toMatch(/Could not open a connection to your authentication agent\./);
  });

  it('the remote agent object never holds the client key', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    const listed = await lab.first.executeCommand('ssh -A alice@10.0.0.2 "ssh-add -l"', 'admin\n');
    expect(listed).toMatch(/ED25519/);
    expect(lab.agentOf(lab.second).list()).toHaveLength(0);
  });

  it('the signature for the second hop is made by the client agent', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    const pub = await lab.first.executeCommand('cat ~/.ssh/agent_key.pub');
    await authorize(lab.third, pub);
    const signed: number[] = [];
    const agent = lab.agentOf(lab.first);
    const original = agent.sign.bind(agent);
    agent.sign = (blob, data, flags) => {
      const signature = original(blob, data, flags);
      signed.push(signature === null ? 0 : signature.length);
      return signature;
    };
    const out = await lab.first.executeCommand(
      'ssh -A -o PreferredAuthentications=password alice@10.0.0.2 "ssh -o PasswordAuthentication=no alice@10.0.0.3 hostname"',
      'admin\n',
    );
    expect(out).toMatch(/third/);
    expect(signed.length).toBeGreaterThan(0);
    expect(lab.agentOf(lab.second).list()).toHaveLength(0);
  });

  it('a key added from the remote lands in the client agent', async () => {
    await lab.first.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/agent_key");
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    expect(lab.agentOf(lab.first).list()).toHaveLength(1);
    await lab.first.executeCommand('ssh -A alice@10.0.0.2 "ssh-keygen -t ed25519 -N \'\' -f ~/.ssh/remote_key && ssh-add ~/.ssh/remote_key"', 'admin\n');
    expect(lab.agentOf(lab.first).list()).toHaveLength(2);
    expect(lab.agentOf(lab.second).list()).toHaveLength(0);
  });

  it('a key removed from the remote leaves the client agent', async () => {
    await lab.first.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/agent_key");
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    await lab.first.executeCommand('ssh -A alice@10.0.0.2 "ssh-add -D"', 'admin\n');
    expect(lab.agentOf(lab.first).list()).toHaveLength(0);
  });

  it('the chain A -> B -> C reaches the first agent', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    await authorize(lab.third, await lab.first.executeCommand('cat ~/.ssh/agent_key.pub'));
    const out = await lab.first.executeCommand(
      'ssh -A alice@10.0.0.2 "ssh -A -o PasswordAuthentication=no alice@10.0.0.3 ssh-add -l"', 'admin\n');
    expect(out).toMatch(/ED25519/);
    expect(lab.agentOf(lab.second).list()).toHaveLength(0);
    expect(lab.agentOf(lab.third).list()).toHaveLength(0);
  });

  it('AllowAgentForwarding no refuses the request', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    await lab.second.executeCommand("sudo sh -c 'echo AllowAgentForwarding no >> /etc/ssh/sshd_config'");
    await lab.second.executeCommand('sudo systemctl reload ssh');
    const out = await lab.first.executeCommand('ssh -A alice@10.0.0.2 \'echo sock=$SSH_AUTH_SOCK\'', 'admin\n');
    expect(out).toMatch(/^sock=\s*$/m);
  });

  it('agent traffic crosses the wire: -A costs more frames', async () => {
    await loadKeyIntoClientAgent(lab);
    await lab.first.executeCommand('ssh-add ~/.ssh/agent_key');
    const count = async (flag: string): Promise<number> => {
      const port = lab.first.getPorts()[0];
      const before = port.getCounters().framesOut;
      await lab.first.executeCommand(`ssh ${flag} alice@10.0.0.2 "ssh-add -l"`, 'admin\n');
      return port.getCounters().framesOut - before;
    };
    const without = await count('');
    const withAgent = await count('-A');
    expect(withAgent).toBeGreaterThan(without);
  });
});
