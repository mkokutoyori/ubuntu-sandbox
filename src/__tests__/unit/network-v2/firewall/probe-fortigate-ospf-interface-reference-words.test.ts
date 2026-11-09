/*
 * Probe: `config router ospf` > `config ospf-interface` named its authentication keyword `md5` and its key attribute `key`,
 * where FortiOS 7.4.12 (p.1157, and 7.6.7 alike) says `authentication [none|text|message-digest]` and `config md5-keys` >
 * `set key-string {password}`. A learner typing the documented `set key-string` was told "unknown attribute", so OSPF
 * MD5 authentication could not be configured with the real command (the engine behind it was sound: it authenticates against
 * a Cisco router in probe-ospf-message-digest-key). The schema now carries the documented words; the earlier invented
 * `md5` is refused like any other unknown keyword.
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (text authentication with its
 * authentication-key) passes either way.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';

async function ospfInterface(...lines: string[]): Promise<{ fgt: FortiGate; typed: string }> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const typed: string[] = [];
  for (const line of [
    'config router ospf', 'config ospf-interface', 'edit "x"', 'set interface "port1"', ...lines, 'next', 'end', 'end',
  ]) typed.push(await fgt.executeCommand(line));
  return { fgt, typed: typed.join('\n') };
}

describe('router ospf ospf-interface authentication words', () => {
  it('witness: text authentication keeps its authentication-key', async () => {
    const { fgt, typed } = await ospfInterface('set authentication text', 'set authentication-key "Secret1"');
    expect(typed).not.toMatch(/Command fail|unknown/i);
    expect(await fgt.executeCommand('show router ospf')).toContain('set authentication text');
  });

  it('message-digest with a key-string is accepted and shown', async () => {
    const { fgt, typed } = await ospfInterface(
      'set authentication message-digest', 'config md5-keys', 'edit 1', 'set key-string "OspfSecret2026"', 'next', 'end');
    expect(typed).not.toMatch(/Command fail|unknown/i);
    const shown = await fgt.executeCommand('show router ospf');
    expect(shown).toContain('set authentication message-digest');
    expect(shown).toMatch(/edit 1\s+set key-string /);
  });

  it('the key is a secret: show prints it encrypted, never in clear', async () => {
    const { fgt } = await ospfInterface(
      'set authentication message-digest', 'config md5-keys', 'edit 1', 'set key-string "OspfSecret2026"', 'next', 'end');
    const shown = await fgt.executeCommand('show router ospf');
    expect(shown).toMatch(/set key-string ENC \S+/);
    expect(shown).not.toContain('OspfSecret2026');
  });

  it('the invented `md5` keyword is refused', async () => {
    const { typed } = await ospfInterface('set authentication md5');
    expect(typed).toMatch(/Command fail|parse error|invalid/i);
  });
});
