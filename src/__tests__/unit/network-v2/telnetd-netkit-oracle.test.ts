/*
 * Oracle: the Ubuntu 22.04 `in.telnetd` (netkit-telnetd 0.17-44build1) run the way inetd runs it by scripts/oracle/record_telnetd.py and
 * recorded in src/__tests__/support/oracle/telnetd-netkit.json: 13 scripted clients, for each step the bytes the daemon wrote. Only the
 * Telnet commands are compared (offers, replies, suboption requests): /bin/login does not run in the recording container, so the login
 * text is not part of the oracle. The AYT reply, which is data, is compared on its own.
 *
 * Before the Linux server had its own negotiation policy it spoke the IOS one (WILL ECHO, WILL SGA first), so every scenario that
 * looks at the opening offer or at what follows the client's answers fell.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import corpus from '../../support/oracle/telnetd-netkit.json';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { TelnetClientTransport } from '@/network/protocols/telnet/TelnetClientSession';
import { fromHex, settle, toHex } from '../../support/telnet/NetkitPty';

interface Step { step: string | [string, string | number]; got: string; closed: boolean }
interface Scenario { steps: Array<[string, string | number]>; result: Step[] }

const scenarios = (corpus as unknown as { scenarios: Record<string, Scenario> }).scenarios;
const IAC = 255;

function commandsOnly(hex: string): string {
  const bytes = Array.from(fromHex(hex), (c) => c.charCodeAt(0));
  const kept: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== IAC) continue;
    const command = bytes[i + 1];
    if (command >= 251 && command <= 254) {
      kept.push(IAC, command, bytes[i + 2]);
      i += 2;
    } else if (command === 250) {
      let end = i + 2;
      while (end < bytes.length - 1 && !(bytes[end] === IAC && bytes[end + 1] === 240)) end++;
      kept.push(...bytes.slice(i, end + 2));
      i = end + 1;
    } else {
      kept.push(IAC, command);
      i += 1;
    }
  }
  return kept.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildServer(): Promise<{ pc: LinuxPC; server: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  new Cable('cab').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
  await server.executeCommand('systemctl start telnet');
  return { pc, server };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('in.telnetd 0.17 — negotiation against the real daemon', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (name === 'controls' || name === 'ayt-after-login' || name === 'login-ok-commands' || name === 'login-ok-term' || name === 'bad-login-three-times') continue;
    it(name, async () => {
      const { pc } = await buildServer();
      const socket = await (pc as unknown as { tcpConnect(h: string, p: number): Promise<TelnetClientTransport | null> }).tcpConnect('10.0.0.20', 23);
      expect(socket).not.toBeNull();
      let received = '';
      socket!.onData((chunk) => { received += chunk; });
      await settle(20);
      const observed: string[] = [commandsOnly(toHex(received))];
      received = '';
      for (const [kind, payload] of scenario.steps) {
        if (kind === 'send') socket!.write(fromHex(payload as string));
        else if (kind === 'shutdown') socket!.close();
        await settle(20);
        observed.push(commandsOnly(toHex(received)));
        received = '';
      }
      expect(observed).toEqual(scenario.result.map((r) => commandsOnly(r.got)));
    });
  }
});
