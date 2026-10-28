/*
 * The class-map, policy-map, control-plane, zone and zone-pair sub-modes
 * declared natively on the socle instead of re-read from the trie.
 *
 * Measured before the change: 1 of the 10 cases falls — a zone description
 * was stored and never rendered in the running-config, so a topology saved
 * and reloaded lost it. The other nine are witnesses: the typed grammar the
 * socle declares was already enforced by the trie adapter (an unknown match
 * criterion, an access list beyond 2799, a bad service-policy direction),
 * so this migration removes the second source of the grammar rather than
 * changing what is accepted.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string>; cliHelp(line: string): string };

async function router(...lines: string[]): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', ...lines]) await r.executeCommand(l);
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;
const running = (r: Cli) => r.executeCommand('do show running-config');

describe('class-map sub-mode', () => {
  it('witness: the four match forms are recorded', async () => {
    const r = await router('class-map type inspect match-any CM',
      'match access-group name ACL1', 'match access-group 101', 'match protocol tcp', 'match any');
    const config = await running(r);
    expect(config).toContain('match access-group name ACL1');
    expect(config).toContain('match access-group 101');
    expect(config).toContain('match protocol tcp');
  });

  it('refuses a match criterion it does not know', async () => {
    const r = await router('class-map type inspect match-any CM');
    expect(await r.executeCommand('match zorglub')).toMatch(CARET);
  });

  it('witness: an access list number beyond 2799 is refused', async () => {
    const r = await router('class-map type inspect match-any CM');
    expect(await r.executeCommand('match access-group 9999')).toMatch(CARET);
  });

  it('a match protocol without its protocol is incomplete', async () => {
    const r = await router('class-map type inspect match-any CM');
    expect(await r.executeCommand('match protocol')).toContain('% Incomplete command.');
  });
});

describe('policy-map, control-plane, zone and zone-pair sub-modes', () => {
  it('witness: class, class-default and class type inspect enter the class mode', async () => {
    const r = await router('policy-map type inspect PM');
    expect(await r.executeCommand('class type inspect CM')).toBe('');
    await r.executeCommand('exit');
    expect(await r.executeCommand('class class-default')).toBe('');
  });

  it('refuses a class without its name', async () => {
    const r = await router('policy-map type inspect PM');
    expect(await r.executeCommand('class')).toContain('% Incomplete command.');
  });

  it('witness: control-plane service-policy input/output are recorded', async () => {
    const r = await router('control-plane', 'service-policy input COPP', 'service-policy output COPP2');
    const config = await running(r);
    expect(config).toContain('service-policy input COPP');
    expect(config).toContain('service-policy output COPP2');
  });

  it('refuses a service-policy direction it does not know', async () => {
    const r = await router('control-plane');
    expect(await r.executeCommand('service-policy sideways COPP')).toMatch(CARET);
  });

  it('witness: a zone description is recorded', async () => {
    const r = await router('zone security INSIDE', 'description inner network');
    expect(await running(r)).toContain('description inner network');
  });

  it('zone-pair service-policy needs `type inspect` and a policy', async () => {
    const r = await router('zone security A', 'zone security B',
      'zone-pair security AB source A destination B');
    expect(await r.executeCommand('service-policy type inspect PM')).toBe('');
    expect(await r.executeCommand('service-policy PM')).toMatch(CARET);
  });
});
