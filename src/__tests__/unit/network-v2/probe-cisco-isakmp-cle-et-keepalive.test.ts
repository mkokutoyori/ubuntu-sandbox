/*
 * `crypto isakmp key`, `crypto isakmp keepalive` and `crypto isakmp nat
 * keepalive` declared natively on the socle.
 *
 * Measured before the change: 6 of the 10 cases fall — a trailing word after
 * `key K address A` was accepted, `key K hostname 10.0.0.1` was refused with
 * the bare wording and no caret line, `keepalive 10 3 zorglub` was accepted
 * with the mode silently defaulted, `keepalive` outside 10-3600 / 2-60 was
 * accepted (the ranges Cisco documents for the periodic DPD interval and
 * retry), and `nat keepalive zorglub` was accepted and did nothing. The other
 * four are witnesses: the address, wildcard and hostname forms, the removals,
 * and the valid keepalives. The policy `encryption` cases added after that
 * measurement: 3 of 4 fall before (`aes 256 zorglub`, `aes 100` and `3des
 * zorglub` were accepted through an untyped tail and stored verbatim).
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function router(...lines: string[]): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', ...lines]) await r.executeCommand(l);
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;
const running = (r: Cli) => r.executeCommand('do show running-config');

describe('crypto isakmp key', () => {
  it('witness: address, wildcard and hostname forms are applied', async () => {
    const r = await router('crypto isakmp key K1 address 10.0.0.1',
      'crypto isakmp key WILD address 0.0.0.0 0.0.0.0', 'crypto isakmp key K2 hostname Peer.Lab');
    const config = await running(r);
    expect(config).toContain('crypto isakmp key K1 address 10.0.0.1');
    expect(config).toContain('crypto isakmp key WILD address 0.0.0.0');
    expect(config).toContain('hostname peer.lab');
  });

  it('refuses a trailing word after the address', async () => {
    const r = await router();
    expect(await r.executeCommand('crypto isakmp key K address 10.0.0.1 zorglub')).toMatch(CARET);
  });

  it('witness: a hostname that is an address is refused', async () => {
    const r = await router();
    expect(await r.executeCommand('crypto isakmp key K hostname 10.0.0.1')).toMatch(CARET);
  });

  it('witness: no removes the key, with or without the key word', async () => {
    const r = await router('crypto isakmp key K1 address 10.0.0.1',
      'crypto isakmp key K2 address 10.0.0.2');
    await r.executeCommand('no crypto isakmp key K1 address 10.0.0.1');
    await r.executeCommand('no crypto isakmp key address 10.0.0.2');
    const config = await running(r);
    expect(config).not.toContain('10.0.0.1');
    expect(config).not.toContain('10.0.0.2');
  });
});

describe('crypto isakmp keepalive', () => {
  it('witness: interval, retries and mode are applied, retries and mode are optional', async () => {
    const r = await router();
    expect(await r.executeCommand('crypto isakmp keepalive 20 5 on-demand')).toBe('');
    expect(await r.executeCommand('crypto isakmp keepalive 20')).toBe('');
    expect(await r.executeCommand('crypto isakmp keepalive 20 periodic')).toBe('');
    expect(await r.executeCommand('no crypto isakmp keepalive')).toBe('');
  });

  it.each([
    'crypto isakmp keepalive 10 3 zorglub',
    'crypto isakmp keepalive 9 5',
    'crypto isakmp keepalive 20 1',
  ])('refuses `%s` at the caret', async (line) => {
    expect(await (await router()).executeCommand(line)).toMatch(CARET);
  });

  it('refuses a NAT keepalive that is not a number', async () => {
    expect(await (await router()).executeCommand('crypto isakmp nat keepalive zorglub'))
      .toMatch(CARET);
  });

  it('witness: a NAT keepalive interval is applied', async () => {
    expect(await (await router()).executeCommand('crypto isakmp nat keepalive 20')).toBe('');
  });
});

describe('crypto isakmp policy encryption', () => {
  it('witness: aes with and without a key size, 3des and des are applied', async () => {
    const r = await router('crypto isakmp policy 10');
    for (const line of ['encryption aes', 'encryption aes 256', 'encryption 3des', 'encryption des']) {
      expect(await r.executeCommand(line), line).toBe('');
    }
  });

  it.each(['encryption aes 256 zorglub', 'encryption aes 100', 'encryption 3des zorglub'])(
    'refuses `%s` at the caret', async (line) => {
      expect(await (await router('crypto isakmp policy 10')).executeCommand(line)).toMatch(CARET);
    });
});
