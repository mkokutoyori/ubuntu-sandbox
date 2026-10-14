/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands D to L):
 * `ip ssh stricthostkeycheck` and `ip ssh pubkey-chain`.
 *
 *   stricthostkeycheck  the router authenticates every SSH server it connects to; with no
 *                       `ip ssh pubkey-chain` configured the connection FAILS (SSH version 2)
 *   pubkey-chain        keys for user and server authentication; a server whose host key is not in
 *                       the chain is refused
 *
 * The `server <name>` sub-mode of the chain (and its key-hash / key-string) is not described in the
 * attached books, which only say that the chain serves "user and server authentication": its
 * grammar follows IOS practice and is the one thing here that could not be checked against them.
 *
 * Lab: a CiscoRouter typing `ssh -l alice 10.0.0.2` toward a LinuxServer through a switch; the key
 * exchange, the host key and the refusal all cross the cable.
 *
 * Measured with src stashed to HEAD: 3 of the 6 cases fall (the connection is never refused, and the
 * chain keeps no server entry). Three pass either way: the witness, and the two "accepted" cases,
 * which an unchecked router accepts too -- they prove the check lets a trusted key through, not
 * that it was absent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '@/terminal/sessions/LinuxTerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';
import { allowLegacyIosSshServer } from '@/__tests__/unit/network-v2/iosLegacySsh';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { keyHashOfMaterial } from '@/network/devices/router/security/SshPubkeyChain';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let router: CiscoRouter;
let server: LinuxServer;
let term: CiscoTerminalSession;

const screen = (): string => term.lines.map((l) => l.text).join('\n');

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await tick();
}

async function typeLine(line: string): Promise<void> {
  term.setInput(line);
  term.handleKey(key('Enter'));
  await tick();
}

async function login(): Promise<void> {
  await typeLine('ssh -l alice 10.0.0.2');
  await until(() => term.currentInputMode.type === 'password' || /verification failed|refused/i.test(screen()));
  if (term.currentInputMode.type === 'password') {
    term.setPasswordBuf('pw');
    term.handleKey(key('Enter'));
    await until(() => term.getPrompt().includes('alice@') || /denied/.test(screen()));
  }
}

async function hostKeyMaterial(): Promise<string> {
  await login();
  await typeLine('exit');
  await until(() => term.getPrompt().startsWith('R1'));
  const line = await server.executeCommand('cat /etc/ssh/ssh_host_rsa_key.pub');
  return line.trim().split(/\s+/)[1];
}

async function configure(lines: string[]): Promise<void> {
  for (const c of ['configure terminal', ...lines, 'end']) await router.executeCommand(c);
}

beforeEach(async () => {
  installDefaultShells();
  EquipmentRegistry.getInstance().clear();
  router = new CiscoRouter('R1', 0, 0);
  server = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c0').connect(router.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[1]);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  for (const command of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${router.getPortNames()[0]}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await router.executeCommand(command);
  allowLegacyIosSshServer(server);
  await server.executeCommand('sudo useradd -m alice');
  await server.executeCommand('echo "alice:pw" | sudo chpasswd');
  term = new CiscoTerminalSession('t1', router);
  await term.init();
  await typeLine('enable');
});

describe('ip ssh stricthostkeycheck', () => {
  it('witness: without the command the router connects and logs in', async () => {
    await login();
    expect(term.getPrompt()).toMatch(/^alice@/);
  });

  it('with no pubkey-chain configured the connection fails', async () => {
    await configure(['ip ssh stricthostkeycheck']);
    await login();
    expect(term.getPrompt()).not.toMatch(/^alice@/);
    expect(screen()).toMatch(/Host key verification failed|not known|refused/i);
  });

  it('a server whose host key is not in the chain is refused', async () => {
    await configure([
      'ip ssh stricthostkeycheck', 'ip ssh pubkey-chain', 'server 10.0.0.2',
      'key-hash ssh-rsa 00000000000000000000000000000000', 'exit', 'exit',
    ]);
    await login();
    expect(term.getPrompt()).not.toMatch(/^alice@/);
  });

  it('a server whose host key hash is in the chain is accepted', async () => {
    const hash = keyHashOfMaterial(await hostKeyMaterial());
    await configure([
      'ip ssh stricthostkeycheck', 'ip ssh pubkey-chain', 'server 10.0.0.2',
      `key-hash ssh-rsa ${hash}`, 'exit', 'exit',
    ]);
    await login();
    expect(term.getPrompt()).toMatch(/^alice@/);
  });

  it('a server key entered with key-string is accepted as well', async () => {
    const material = await hostKeyMaterial();
    await configure([
      'ip ssh stricthostkeycheck', 'ip ssh pubkey-chain', 'server 10.0.0.2', 'key-string',
      `ssh-rsa ${material}`, 'exit', 'exit', 'exit',
    ]);
    await login();
    expect(term.getPrompt()).toMatch(/^alice@/);
  });

  it('the chain, the server entries and the command are rendered, and the no form lifts the check', async () => {
    const hash = keyHashOfMaterial(await hostKeyMaterial());
    await configure([
      'ip ssh stricthostkeycheck', 'ip ssh pubkey-chain', 'server 10.0.0.2', `key-hash ssh-rsa ${hash}`, 'exit', 'exit',
    ]);
    const config = await router.executeCommand('show running-config');
    expect(config).toContain('ip ssh stricthostkeycheck');
    expect(config).toMatch(new RegExp(`server 10\\.0\\.0\\.2\\n\\s+key-hash ssh-rsa ${hash}`));
    await configure(['no ip ssh stricthostkeycheck']);
    await login();
    expect(term.getPrompt()).toMatch(/^alice@/);
  });
});
