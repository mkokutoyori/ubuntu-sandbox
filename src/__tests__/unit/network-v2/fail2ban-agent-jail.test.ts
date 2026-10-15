/**
 * Fail2banAgent: le jail sshd compte lui-meme les echecs. Onze cas, les onze tombent avant
 * la correction : l'agent ne reagissait qu'aux evenements `auth_throttled` de SshAuthThrottler
 * (une liste noire dans le protocole que ni sshd ni fail2ban n'ont) et `jail`, `isActive`,
 * `attach`, `totalFailed` n'existaient pas. Le premier cas est le temoin : meme laboratoire,
 * il prouve que le ban tombe a la `maxretry`-ieme echec et que la regle REJECT est posee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SshServerEventBus } from '@/network/protocols/ssh/server/SshServerEvent';
import { Fail2banAgent } from '@/network/protocols/ssh/security/Fail2banAgent';
import { VirtualTimeScheduler } from '@/events/Scheduler';

interface Lab {
  readonly bus: SshServerEventBus;
  readonly agent: Fail2banAgent;
  readonly scheduler: VirtualTimeScheduler;
  readonly iptables: string[][];
  readonly log: string[];
  setActive(active: boolean): void;
  fail(ip: string): void;
}

function build(jail = { maxretry: 3, findtimeSeconds: 60, bantimeSeconds: 120 }): Lab {
  const bus = new SshServerEventBus();
  const scheduler = new VirtualTimeScheduler();
  const iptables: string[][] = [];
  const log: string[] = [];
  const chains = new Set<string>();
  let active = true;
  const agent = new Fail2banAgent(
    bus,
    {
      execute: (args) => {
        iptables.push(args);
        if (args[0] === '-N') chains.add(args[1]);
        return { exitCode: 0 };
      },
      hasChain: (name) => chains.has(name),
    },
    { appendLog: (line) => { log.push(line); } },
    { jail, isActive: () => active, scheduler, clock: () => scheduler.now() },
  );
  return {
    bus, agent, scheduler, iptables, log,
    setActive: (value) => { active = value; },
    fail: (ip) => { bus.emit({ kind: 'auth_failure', user: 'bob', ip, reason: 'bad_password', method: 'password' }); },
  };
}

describe('Fail2banAgent counts failures itself', () => {
  let lab: Lab;
  beforeEach(() => { lab = build(); });

  it('bans the address on the maxretry-th failure and not before (witness)', () => {
    lab.fail('10.0.0.9');
    lab.fail('10.0.0.9');
    expect(lab.agent.bannedIps()).toEqual([]);
    lab.fail('10.0.0.9');
    expect(lab.agent.bannedIps()).toEqual(['10.0.0.9']);
    expect(lab.iptables).toContainEqual(['-I', 'f2b-sshd', '1', '-s', '10.0.0.9', '-j', 'REJECT']);
  });

  it('writes one Found line per failure, then the Ban', () => {
    for (let i = 0; i < 3; i += 1) lab.fail('10.0.0.9');
    expect(lab.log.filter((line) => line.includes('Found 10.0.0.9'))).toHaveLength(3);
    expect(lab.log[lab.log.length - 1]).toContain('NOTICE  [sshd] Ban 10.0.0.9');
  });

  it('counts each address on its own', () => {
    lab.fail('10.0.0.9');
    lab.fail('10.0.0.8');
    lab.fail('10.0.0.9');
    lab.fail('10.0.0.8');
    expect(lab.agent.bannedIps()).toEqual([]);
    lab.fail('10.0.0.9');
    expect(lab.agent.bannedIps()).toEqual(['10.0.0.9']);
  });

  it('forgets failures older than findtime', () => {
    lab.fail('10.0.0.9');
    lab.fail('10.0.0.9');
    lab.scheduler.advance(61_000);
    lab.fail('10.0.0.9');
    expect(lab.agent.bannedIps()).toEqual([]);
  });

  it('sees nothing while the fail2ban service is not running', () => {
    lab.setActive(false);
    for (let i = 0; i < 5; i += 1) lab.fail('10.0.0.9');
    expect(lab.agent.bannedIps()).toEqual([]);
    expect(lab.log).toEqual([]);
    expect(lab.iptables).toEqual([]);
  });

  it('lifts the ban by itself after bantime and removes the rule', () => {
    for (let i = 0; i < 3; i += 1) lab.fail('10.0.0.9');
    lab.scheduler.advance(119_000);
    expect(lab.agent.bannedIps()).toEqual(['10.0.0.9']);
    lab.scheduler.advance(2_000);
    expect(lab.agent.bannedIps()).toEqual([]);
    expect(lab.iptables).toContainEqual(['-D', 'f2b-sshd', '-s', '10.0.0.9', '-j', 'REJECT']);
    expect(lab.log[lab.log.length - 1]).toContain('[sshd] Unban 10.0.0.9');
  });

  it('forceUnban lifts a ban at once and says whether there was one', () => {
    for (let i = 0; i < 3; i += 1) lab.fail('10.0.0.9');
    expect(lab.agent.forceUnban('10.0.0.9')).toBe(true);
    expect(lab.agent.forceUnban('10.0.0.9')).toBe(false);
    expect(lab.agent.bannedIps()).toEqual([]);
  });

  it('counts every failure it saw, banned or not', () => {
    lab.fail('10.0.0.9');
    lab.fail('10.0.0.8');
    expect(lab.agent.totalFailed()).toBe(2);
  });

  it('reports the jail bantime, not the length of the last ban', () => {
    expect(lab.agent.bantimeSeconds()).toBe(120);
  });

  it('creates the jail chain once and jumps INPUT traffic for the port into it', () => {
    for (let i = 0; i < 3; i += 1) lab.fail('10.0.0.9');
    for (let i = 0; i < 3; i += 1) lab.fail('10.0.0.8');
    expect(lab.iptables.filter((args) => args[0] === '-N')).toHaveLength(1);
    expect(lab.iptables).toContainEqual(['-I', 'INPUT', '-p', 'tcp', '--dport', '22', '-j', 'f2b-sshd']);
  });

  it('listens to a second bus once attached, as after a reload of sshd', () => {
    const other = new SshServerEventBus();
    lab.agent.attach(other);
    for (let i = 0; i < 3; i += 1) other.emit({ kind: 'auth_failure', user: 'bob', ip: '10.0.0.7', reason: 'bad_password', method: 'password' });
    expect(lab.agent.bannedIps()).toEqual(['10.0.0.7']);
  });
});
