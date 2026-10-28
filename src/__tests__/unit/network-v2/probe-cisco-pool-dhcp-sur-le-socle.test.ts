/*
 * The DHCP pool sub-mode (`ip dhcp pool`) declared natively on the socle
 * instead of re-read from the trie.
 *
 * Measured before the change: 4 of the 8 cases fall. `option 43 ?` did not
 * name its formats (the old REST place announced the code and the formats
 * together on `option ?`), and the eight-address limit, the unusable host
 * addresses and the lease bounds were refused with the bare
 * "% Invalid input detected at '^' marker." and no caret line. The other four
 * are witnesses that pin behaviour the migration keeps: the utilization mark
 * floors, the node types, the raw option checks and the pool requirement.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string>; cliHelp(line: string): string };

async function pool(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'ip dhcp pool P']) await r.executeCommand(l);
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;

describe('ip dhcp pool sub-mode on the socle', () => {
  it('`option 43 ?` names the three formats once the code is typed', async () => {
    const help = (await pool()).cliHelp('option 43 ');
    for (const form of ['ascii', 'hex', 'ip']) expect(help, form).toContain(form);
  });

  it('witness: eight default routers are accepted, nine are not', async () => {
    const r = await pool();
    const eight = Array.from({ length: 8 }, (_u, i) => `10.0.0.${i + 1}`).join(' ');
    expect(await r.executeCommand(`default-router ${eight}`)).toBe('');
    expect(await r.executeCommand(`default-router ${eight} 10.0.0.9`)).toMatch(CARET);
  });

  it('witness: a multicast or zero-net router is refused', async () => {
    const r = await pool();
    expect(await r.executeCommand('default-router 224.0.0.1')).toMatch(CARET);
    expect(await r.executeCommand('dns-server 0.1.2.3')).toMatch(CARET);
  });

  it('witness: a lease of zero or beyond 365 days is refused', async () => {
    const r = await pool();
    expect(await r.executeCommand('lease 0 0 0')).toContain("Invalid input detected");
    expect(await r.executeCommand('lease 400')).toMatch(CARET);
    expect(await r.executeCommand('lease 1 2 3')).toBe('');
  });

  it('witness: `utilization mark high 0` is refused, `low 0` is not', async () => {
    const r = await pool();
    expect(await r.executeCommand('utilization mark high 0')).toMatch(CARET);
    expect(await r.executeCommand('utilization mark low 0')).toBe('');
  });

  it('witness: only the four NetBIOS node types exist', async () => {
    const r = await pool();
    expect(await r.executeCommand('netbios-node-type h-node')).toBe('');
    expect(await r.executeCommand('netbios-node-type q-node')).toMatch(CARET);
  });

  it('witness: a raw option needs a code in range and a known format', async () => {
    const r = await pool();
    expect(await r.executeCommand('option 43 ascii hello')).toBe('');
    expect(await r.executeCommand('option 999 ascii x')).toMatch(CARET);
    expect(await r.executeCommand('option 43 zzz x')).toMatch(CARET);
  });

  it('witness: the pool commands need a pool of their own', async () => {
    const r = new CiscoRouter('R2', 0, 0) as unknown as Cli & { powerOn(): void };
    r.powerOn();
    for (const l of ['enable', 'configure terminal']) await r.executeCommand(l);
    expect(await r.executeCommand('lease 1')).toMatch(/Invalid input|No DHCP pool/);
  });
});
