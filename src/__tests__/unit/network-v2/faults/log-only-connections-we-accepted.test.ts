/**
 * A device logs the connections it ACCEPTED, not the ones it dialled.
 *
 * `tcp.connection.opened` always carried a `passive` flag and both log
 * projections filtered on it. `tcp.connection.closed` did not carry one
 * at all, so neither projection could tell the two apart — and both
 * logged every close as `Connection from <peer> closed (<reason>)`,
 * including the close of a socket this very device had opened.
 *
 * The visible consequence was a server-shaped line on the console of a
 * CLIENT: a router whose outbound `telnet` had just been refused printed
 * `%SYS-6-INFORMATIONAL: Connection from 10.0.0.1:23 closed (rst)` — as
 * if somebody had connected TO it — right under the refusal. On a Linux
 * host the same close was tagged `sshd`, a daemon that had accepted
 * nothing.
 *
 * The second case used to assert the opposite half — that an accepted
 * inbound connection still produced a line — and it went red when the
 * Cisco emitters were removed as fabrications: `223a6181` dropped
 * `Connection from <peer> closed (<reason>)` and `4dd19ad6` dropped the
 * `SSH2_SESSION` line raised on a bare TCP accept, both on the measured
 * ground that no IOS says either. A TCP connection is neither an
 * established SSH session nor an authentication, and IOS logs nothing at
 * that instant — what it logs is the SESSION, from
 * `router.ssh.session.opened`. The case now pins that measured silence
 * on BOTH sides, so re-introducing the invented wording fails here.
 *
 * The `passive` filter this file is named for stays live on the LINUX
 * side (`PortActivityLogProjection`, which really does write
 * `Accepted connection from …`), exercised on a real machine — a real
 * cable, a real ssh login — in `sshd-speaks-with-one-voice.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** A Cisco router cabled to another, both with a real console log buffer. */
async function twoRouters(): Promise<{ client: CiscoRouter; target: CiscoRouter }> {
  const client = new CiscoRouter('client', 0, 0);
  const target = new CiscoRouter('target', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(target.getPorts()[0], sw.getPorts()[1]);

  const setup = (r: CiscoRouter, ip: string) => [
    'enable', 'configure terminal',
    'logging buffered 8000 debugging',
    'interface GigabitEthernet0/0', `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048',
    'end',
  ].map((c) => r.executeCommand(c));

  for (const p of setup(client, '10.0.0.2')) await p;
  for (const p of setup(target, '10.0.0.1')) await p;
  return { client, target };
}

describe('a router logs inbound connections, never its own outbound ones', () => {
  it('a refused OUTBOUND connection leaves no "Connection from" line on the client', async () => {
    const { client, target } = await twoRouters();
    // Close the door: nothing is listening on 23 any more.
    for (const c of ['enable', 'configure terminal', 'line vty 0 4', 'transport input ssh', 'end']) {
      await target.executeCommand(c);
    }

    // Through the TERMINAL, not `executeCommand`: only the interactive
    // launcher opens a real socket, and only a real socket produces the
    // close event this is about.
    const t = createSessionForDevice(client, 't')!;
    await t.init();
    t.setInput('telnet 10.0.0.1');
    t.handleKey(key('Enter'));
    await flush();

    // The refusal itself is on screen — the fault is a fact…
    expect(t.lines.map((l) => l.text).join('\n'))
      .toContain('% Connection refused by remote host');
    // …and the client's own log says nothing about having accepted it.
    const log = await client.executeCommand('show logging');
    expect(log).not.toContain('Connection from 10.0.0.1:23');
  });

  it('a bare inbound TCP connection is logged by NEITHER side', async () => {
    const { client, target } = await twoRouters();

    const socket = await client.getTcpStack().connect('10.0.0.1', 22);
    expect(socket, 'the lab must really connect, or this proves nothing').toBeTruthy();

    for (const [name, device] of [['target', target], ['client', client]] as const) {
      const log = await device.executeCommand('show logging');
      expect(log, `${name} invented a line for a bare TCP connection`)
        .not.toMatch(/Connection from|connection from/);
    }
  });
});
