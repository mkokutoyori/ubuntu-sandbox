/**
 * `docs/PRD-Journalisation-Cisco.md` — what a syslog collector receives is
 * what the device logged, once each.
 *
 * Measured before anything was changed, on a router whose collector sits on
 * a link the test does NOT take down (the first version of this lab shut the
 * only interface carrying syslog, so the messages could not leave and the
 * measurement said nothing): five lines in `show logging` produced TWELVE
 * datagrams. Every line arrived twice, and two extra `%PORT-6-ADMIN` — a
 * message no IOS writes, absent from the same machine's own log.
 *
 * Discrimination — restore `src/network/syslog/SyslogAgent.ts`,
 * `src/network/devices/inspection/config/LoggingConfig.ts` and
 * `src/events/DuplicateEventFilter.ts`: FIVE of the six cases fall,
 * including the fan-out one, which I had predicted would pass either way
 * and does not — both collectors were already reached, but each received
 * every line twice, so comparing against the buffer catches it too. The
 * fan-out case earns its place for a second reason: a fix that
 * deduplicated by message CONTENT instead of by event identity would pass
 * every other case here while silently collapsing two collectors into one.
 * The sixth, "nothing leaves when no collector is declared", passes either
 * way — it guards the fix rather than measuring the defect.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const MASK = '255.255.255.0';

async function ios(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
}

interface Collector {
  readonly ip: string;
  readonly tags: string[];
}

function collect(server: LinuxServer, ip: string): Collector {
  server.getPorts()[0].configureIP(new IPAddress(ip), new SubnetMask(MASK));
  const tags: string[] = [];
  (server as unknown as { udpBind(p: number, cb: (d: unknown) => void): void })
    .udpBind(514, (d) => {
      const payload = (d as { udp?: { payload?: { tag?: string } } }).udp?.payload;
      tags.push(String(payload?.tag ?? ''));
    });
  return { ip, tags };
}

/**
 * The collectors hang off GigabitEthernet0/0; the interface the lab flaps to
 * PRODUCE the messages is GigabitEthernet0/1. Flapping the syslog path itself
 * would lose the very datagrams under measurement, and a router genuinely
 * cannot send them — that is real behaviour, not a defect to test through.
 */
async function lab(extra: string[], collectorIps: readonly string[] = ['10.0.0.9']): Promise<{
  router: CiscoRouter; collectors: Collector[];
}> {
  const router = new CiscoRouter('R1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  router.powerOn();
  sw.powerOn();
  new Cable('c-router').connect(router.getPorts()[0], sw.getPorts()[0]);
  const collectors = collectorIps.map((ip, i) => {
    const server = new LinuxServer('linux-server', `SRV${i}`, 0, 0);
    server.powerOn();
    new Cable(`c-srv${i}`).connect(server.getPorts()[0], sw.getPorts()[i + 1]);
    return collect(server, ip);
  });
  await ios(router, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address 10.0.0.1 ${MASK}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address 10.9.9.1 ${MASK}`, 'no shutdown', 'exit',
    ...extra, 'end']);
  await settle();
  for (const c of collectors) await ios(router, [`ping ${c.ip}`]);
  await settle();
  for (const c of collectors) c.tags.length = 0;
  await ios(router, ['clear logging']);
  return { router, collectors };
}

async function flap(router: CiscoRouter): Promise<void> {
  await ios(router, ['configure terminal', 'interface GigabitEthernet0/1',
    'shutdown', 'no shutdown', 'end']);
  await settle();
}

async function loggedTags(router: CiscoRouter): Promise<string[]> {
  const body = (await ios(router, ['show logging'])).split('Log Buffer')[1] ?? '';
  return body.split('\n')
    .map((l) => (/%[A-Z0-9_]+-\d-[A-Z0-9_]+/.exec(l) ?? [])[0])
    .filter((t): t is string => Boolean(t));
}

describe('a syslog collector receives what the device logged', () => {
  it('one logged line is one datagram, never two', async () => {
    const { router, collectors } = await lab(['logging host 10.0.0.9']);
    await flap(router);
    const logged = await loggedTags(router);

    expect(logged.length).toBeGreaterThan(0);
    expect(collectors[0].tags).toHaveLength(logged.length);
  });

  it('the collector reads the same tags, in the same order, as `show logging`', async () => {
    const { router, collectors } = await lab(['logging host 10.0.0.9']);
    await flap(router);

    expect(collectors[0].tags).toEqual(await loggedTags(router));
  });

  it('no message reaches the collector that the device denies logging', async () => {
    const { router, collectors } = await lab(['logging host 10.0.0.9']);
    await flap(router);
    const logged = new Set(await loggedTags(router));

    expect(collectors[0].tags.length).toBeGreaterThan(0);
    for (const tag of collectors[0].tags) {
      expect(logged, `${tag} left the machine without being logged`).toContain(tag);
    }
  });

  it('`logging trap errors` forwards the severity-3 message and nothing softer', async () => {
    const { router, collectors } = await lab([
      'logging host 10.0.0.9', 'logging trap errors',
    ]);
    await flap(router);

    expect(collectors[0].tags).toEqual(['%LINK-3-UPDOWN']);
    // The buffer keeps them all: `logging trap` governs the relay alone.
    expect((await loggedTags(router)).length).toBeGreaterThan(1);
  });

  it('two collectors each receive the whole log, not half of it', async () => {
    const { router, collectors } = await lab(
      ['logging host 10.0.0.9', 'logging host 10.0.0.8'],
      ['10.0.0.9', '10.0.0.8'],
    );
    await flap(router);
    const logged = await loggedTags(router);

    for (const c of collectors) expect(c.tags, c.ip).toEqual(logged);
  });

  it('with no collector declared, nothing leaves the machine', async () => {
    const { router, collectors } = await lab([]);
    await flap(router);

    expect((await loggedTags(router)).length).toBeGreaterThan(0);
    expect(collectors[0].tags).toEqual([]);
  });
});
