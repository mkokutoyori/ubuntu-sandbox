/*
 * The radius-server, tacacs-server and aaa group sub-modes declared natively
 * on the socle instead of re-read from the trie.
 *
 * Measured before the change: 3 of the 10 cases fall — a RADIUS `auth-port
 * 99999` was stored as is, `auth-port` without its number was silently
 * ignored, and `server zorglub` joined a group under a name that is not an
 * address. The other seven are witnesses that pass either way (valid forms,
 * ports, keys, membership by name, and the address refusals the adapter
 * already made through its typed IP_ADDR place).
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

describe('radius server sub-mode on the socle', () => {
  it('witness: a valid address with both ports is applied', async () => {
    const r = await router('radius server R1',
      'address ipv4 10.0.0.9 auth-port 1812 acct-port 1813', 'key s3cret');
    const config = await running(r);
    expect(config).toContain('address ipv4 10.0.0.9');
    expect(config).toContain('auth-port 1812');
  });

  it('refuses an address that is not an address', async () => {
    const r = await router('radius server R1');
    expect(await r.executeCommand('address ipv4 zorglub')).toMatch(CARET);
  });

  it('refuses a port beyond 65535', async () => {
    const r = await router('radius server R1');
    expect(await r.executeCommand('address ipv4 10.0.0.9 auth-port 99999')).toMatch(CARET);
  });

  it('refuses a port keyword without its number', async () => {
    const r = await router('radius server R1');
    expect(await r.executeCommand('address ipv4 10.0.0.9 auth-port')).toContain('Incomplete');
  });
});

describe('tacacs server sub-mode on the socle', () => {
  it('witness: address, port, timeout and key are applied', async () => {
    const r = await router('tacacs server T1', 'address ipv4 10.0.0.8', 'port 4949',
      'timeout 7', 'key k');
    const config = await running(r);
    expect(config).toContain('address ipv4 10.0.0.8');
    expect(config).toContain('port 4949');
  });

  it('witness: a port of zero is refused', async () => {
    const r = await router('tacacs server T1');
    expect(await r.executeCommand('port 0')).toMatch(CARET);
  });

  it('refuses an address that is not an address', async () => {
    const r = await router('tacacs server T1');
    expect(await r.executeCommand('address ipv4 zorglub')).toMatch(CARET);
  });
});

describe('aaa group server sub-mode on the socle', () => {
  it('witness: a member joins by name and by address, and leaves again', async () => {
    const r = await router('aaa group server tacacs+ G1', 'server name T1', 'server 10.0.0.8');
    let config = await running(r);
    expect(config).toContain('server name T1');
    expect(config).toContain('server name 10.0.0.8');
    await r.executeCommand('no server 10.0.0.8');
    await r.executeCommand('no server name T1');
    config = await running(r);
    expect(config).not.toContain('10.0.0.8');
    expect(config).not.toContain('server name T1');
  });

  it('refuses a legacy member that is not an address', async () => {
    const r = await router('aaa group server tacacs+ G1');
    expect(await r.executeCommand('server zorglub')).toMatch(CARET);
  });

  it('witness: a server needs its member', async () => {
    const r = await router('aaa group server tacacs+ G1');
    expect(await r.executeCommand('server')).toContain('Incomplete');
  });
});
