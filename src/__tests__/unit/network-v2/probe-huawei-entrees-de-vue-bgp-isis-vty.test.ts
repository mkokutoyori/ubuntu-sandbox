/*
 * Huawei view entries that kept a stray word: `bgp 65000 zorglub`, `bgp
 * 65000abc`, `isis 1 zorglub`, `isis zorglub`, `user-interface vty 0 4
 * zorglub`, `user-interface vty 0 zorglub`. Each opened its view (the
 * number was read with parseInt, which stops at the first non-digit, and the
 * rest dropped). VRP answers `Error: Wrong parameter found at '^' position.`
 *
 * Measured before the change: 6 of the 11 cases fall (the six above); the 5
 * witnesses (`bgp 65000`, `bgp 65000 instance X`, `isis`, `isis 2`,
 * `user-interface vty 0 4`) pass either way. Accepted forms (bgp <as>
 * [instance <name>]; isis [id] [vpn-instance <name>]; user-interface vty
 * <0-20> [<0-20>]) are from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function systemView(): Promise<Cli> {
  const r = new HuaweiRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  await r.executeCommand('system-view');
  return r;
}

describe('view entries', () => {
  it.each([
    'bgp 65000', 'bgp 65000 instance X', 'isis', 'isis 2', 'user-interface vty 0 4',
  ])('witness: `%s` opens its view', async (line) => {
    expect(await (await systemView()).executeCommand(line)).not.toMatch(/Wrong parameter|Error/);
  });

  it.each([
    'bgp 65000 zorglub', 'bgp 65000abc', 'isis 1 zorglub', 'isis zorglub',
    'user-interface vty 0 4 zorglub', 'user-interface vty 0 zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await systemView()).executeCommand(line)).toMatch(/Wrong parameter/);
  });
});
