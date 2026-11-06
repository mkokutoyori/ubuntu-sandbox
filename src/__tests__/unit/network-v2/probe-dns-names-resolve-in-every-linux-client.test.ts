/*
 * In the DNS lab, 'ping web.banquehorizon.com' resolved through the machine's resolver (nsswitch: files then the DNS over the wire) while a handful of other
 * clients of the same machine each carried a PRIVATE resolver and failed on a name only the DNS knows: telnet and the terminal's ssh used the topology and
 * /etc/hosts, arping answered 'unknown host', logger -n 'failed to resolve name', openssl s_client 'unable to resolve host' (it read /etc/hosts itself),
 * chronyc read /etc/hosts for 'add server', and wget was a canned stub that failed to resolve EVERY name and refused every connection. Every one of them now
 * asks the machine's resolver (NameResolution.resolveHostnameFor / LinuxMachine.resolveHostname) or, for the engines that are synchronous ports, receives the
 * answers of an asynchronous pre-resolution done through the same call (openssl, chronyc, logger). wget is a real client on the curl engine, so a resolved name
 * is fetched over the wire and printed in wget's own words (formats measured on GNU Wget 1.21.4 against a local server).
 *
 * Each case runs a command on PC-CONSEILLER with the name web.banquehorizon.com (an A record the DNS knows and /etc/hosts does not) and asserts that the command
 * does not report a resolution failure, then runs the same command with a name nobody knows and asserts that it still does.
 *
 * Measured against the commit before (worktree, which already carries the terminal ssh fix): 6 of the 16 cases fall (nc, wget, openssl, arping, logger and telnet on the name only the DNS knows). The 10 that
 * pass either way: the four WITNESSES (ping, curl, nmap, dig), ssh (fixed by the previous commit) and the five 'still fails on a name nobody knows' cases, which are non-regressions: a name
 * nobody knows must keep failing in the client's own words.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

const KNOWN = 'web.banquehorizon.com';
const UNKNOWN = 'nobody.banquehorizon.com';
const FAILURE = /could not resolve|unable to resolve|unknown host|failed to resolve|name or service not known|temporary failure in name resolution|resolution failed|no such host/i;

const WITNESSES = ['ping -c 1 HOST', 'curl -sS -m 3 -o /dev/null http://HOST/', 'nmap -Pn -p 22 HOST', 'dig HOST +short'];
const CLIENTS = [
  'nc -zv -w 2 HOST 22',
  'wget -T 3 -O- http://HOST/',
  'openssl s_client -connect HOST:443 </dev/null',
  'arping -c 1 HOST',
  'logger -n HOST -P 514 -d probe',
  'ssh -o BatchMode=yes -o ConnectTimeout=2 bob@HOST hostname',
  'telnet HOST 22',
];

async function run(command: string): Promise<string> {
  await buildDnsAgenceBancaire();
  const pc = [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'PC-CONSEILLER')!;
  const answers = [String(await (pc as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(command))];
  const session = new LinuxTerminalSession('t', pc as never);
  session.setInput(command);
  session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  await new Promise((resolve) => setTimeout(resolve, 700));
  answers.push(session.lines.map((line) => line.text).join('\n'));
  if (session.inputMode.type !== 'normal') session.handleKey({ key: 'c', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false });
  return answers.join('\n--- terminal ---\n');
}

describe('a name only the DNS knows resolves in every client of the machine', () => {
  it.each(WITNESSES)('WITNESS %s', async (template) => {
    expect(await run(template.replace('HOST', KNOWN))).not.toMatch(FAILURE);
  });

  it.each(CLIENTS)('%s', async (template) => {
    expect(await run(template.replace('HOST', KNOWN))).not.toMatch(FAILURE);
  });

  it.each([...CLIENTS.filter((c) => !c.startsWith('ssh '))])('%s still fails on a name nobody knows', async (template) => {
    expect(await run(template.replace('HOST', UNKNOWN))).toMatch(FAILURE);
  });
});
