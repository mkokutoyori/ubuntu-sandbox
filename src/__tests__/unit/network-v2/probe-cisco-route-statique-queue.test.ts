/*
 * The tail of `ip route <prefix> <mask> <next-hop|interface>` is judged.
 *
 * Measured before the change: 10 of the 16 cases fall. The tail was scanned
 * for `track`, `permanent` and the first number, and every other word was
 * dropped without a sound: `... 10.0.0.2 zorglub`, `... 10.0.0.2 200 zorglub`
 * and `permanent zorglub` were accepted, and `tag 5` was read as the
 * administrative distance (a static route tagged 5 was installed at distance
 * 5). `name` and `tag` were stored on the route and never rendered in the
 * running-config, so a saved topology lost them. The five witnesses (bare form,
 * distance, permanent, track, null interface) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function router(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit']) await r.executeCommand(l);
  return r;
}

const REFUSED = /Invalid input detected|Incomplete command/;
const ROUTE = 'ip route 10.9.0.0 255.255.0.0';

describe('ip route tail', () => {
  it.each([
    `${ROUTE} 10.0.0.2`, `${ROUTE} 10.0.0.2 200`, `${ROUTE} 10.0.0.2 permanent`,
    `${ROUTE} 10.0.0.2 track 5`, `${ROUTE} Null0`,
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await router()).executeCommand(line)).toBe('');
  });

  it.each([
    `${ROUTE} 10.0.0.2 zorglub`, `${ROUTE} 10.0.0.2 200 zorglub`,
    `${ROUTE} 10.0.0.2 permanent zorglub`, `${ROUTE} Null0 zorglub`,
    `${ROUTE} 10.0.0.2 tag zorglub`, `${ROUTE} 10.0.0.2 tag`, `${ROUTE} 10.0.0.2 track zorglub`,
    `${ROUTE} 10.0.0.2 name`, `${ROUTE} 10.0.0.2 300`,
  ])('refuses `%s`', async (line) => {
    expect(await (await router()).executeCommand(line)).toMatch(REFUSED);
  });

  it('a tag is a tag, not the administrative distance, and the name is kept', async () => {
    const r = await router();
    expect(await r.executeCommand(`${ROUTE} 10.0.0.2 name uplink permanent tag 5`)).toBe('');
    const table = await r.executeCommand('do show ip route static');
    expect(table).toContain('[1/0]');
    expect(table).not.toContain('[5/0]');
    expect(await r.executeCommand('do show running-config'))
      .toContain('ip route 10.9.0.0 255.255.0.0 10.0.0.2 name uplink permanent tag 5');
  });

  it('the distance may precede the keywords', async () => {
    const r = await router();
    expect(await r.executeCommand(`${ROUTE} 10.0.0.2 150 name backup permanent`)).toBe('');
    expect(await r.executeCommand('do show ip route static')).toContain('[150/0]');
  });
});
