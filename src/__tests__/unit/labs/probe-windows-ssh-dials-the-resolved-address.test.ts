/**
 * Probe: `ssh user@name` typed on a Windows machine dials the address its resolver returned and keeps
 * the typed name for everything the client prints.
 *
 * User report (lab "DNS - Agence bancaire", PC-GUICHET2, PowerShell prompt):
 *
 *     PS C:\Users\User> ssh alice@banquehorizon.com
 *     ssh: connect to host banquehorizon.com port 22: Connection refused
 *
 * while `Test-NetConnection banquehorizon.com -Port 22` succeeded and `ssh alice@203.0.113.20` asked for
 * the password. Measured: the launcher shared by the PowerShell and nested shells resolved the name,
 * probed the port at the resolved address, then handed the NAME to the TCP connector, which refuses what
 * is not an address. The cmd prompt dialled the address but passed it as the host, so the client printed
 * `alice@203.0.113.20's password:` and recorded `203.0.113.20` in known_hosts where OpenSSH prints and
 * records the name typed.
 *
 * Discrimination (git stash push -- src/terminal src/shell src/network): 4 of 6 cases fall on the base
 * (the two PowerShell names, the cmd password prompt, the cmd known_hosts notice).
 * Pass either way:
 *  - "an address typed in PowerShell asks for the password" is the WITNESS that the lab's sshd answers
 *    this machine;
 *  - "a name that does not exist is not dialled" is non-regression of the resolver's refusal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { Equipment } from '@/network';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { resetWorld } from './_dnsLabBench';

beforeEach(resetWorld);

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  session.setInput(line);
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await settle();
}

async function terminalOf(name: string, shell: 'cmd' | 'powershell'): Promise<WindowsTerminalSession> {
  await buildDnsAgenceBancaire();
  const device = [...useNetworkStore.getState().deviceInstances.values()].find((candidate: Equipment) => candidate.getName() === name);
  const terminal = new WindowsTerminalSession('probe', device as never);
  await terminal.init();
  if (shell === 'powershell') await type(terminal, 'powershell');
  return terminal;
}

const printed = (terminal: TerminalSession): string => terminal.lines.map((line) => line.text).join('\n');
const promptOf = (terminal: TerminalSession): string => {
  const mode = terminal.currentInputMode as { type: string; promptText?: string };
  return mode.type === 'password' ? mode.promptText ?? '' : `not a password prompt (${mode.type})`;
};

describe('ssh to a name from a Windows machine', () => {
  it('an address typed in PowerShell asks for the password', async () => {
    const terminal = await terminalOf('PC-GUICHET2', 'powershell');
    await type(terminal, 'ssh alice@203.0.113.20');
    expect(promptOf(terminal)).toBe("alice@203.0.113.20's password: ");
  }, 120000);

  it('the name of the zone apex typed in PowerShell asks for the password', async () => {
    const terminal = await terminalOf('PC-GUICHET2', 'powershell');
    await type(terminal, 'ssh alice@banquehorizon.com');
    expect(printed(terminal)).not.toContain('Connection refused');
    expect(promptOf(terminal)).toBe("alice@banquehorizon.com's password: ");
  }, 120000);

  it('a CNAME typed in PowerShell asks for the password', async () => {
    const terminal = await terminalOf('PC-GUICHET2', 'powershell');
    await type(terminal, 'ssh alice@www.banquehorizon.com');
    expect(printed(terminal)).not.toContain('Connection refused');
    expect(promptOf(terminal)).toBe("alice@www.banquehorizon.com's password: ");
  }, 120000);

  it('the cmd prompt asks for the password of the name typed, not of its address', async () => {
    const terminal = await terminalOf('PC-GUICHET2', 'cmd');
    await type(terminal, 'ssh alice@banquehorizon.com');
    expect(promptOf(terminal)).toBe("alice@banquehorizon.com's password: ");
  }, 120000);

  it('the cmd prompt records the name typed in known_hosts', async () => {
    const terminal = await terminalOf('PC-GUICHET2', 'cmd');
    await type(terminal, 'ssh alice@banquehorizon.com');
    expect(printed(terminal)).toContain("Warning: Permanently added 'banquehorizon.com' (ED25519) to the list of known hosts.");
    expect(printed(terminal)).not.toContain("Permanently added '203.0.113.20'");
  }, 120000);

  it('a name that does not exist is not dialled', async () => {
    const terminal = await terminalOf('PC-GUICHET2', 'powershell');
    await type(terminal, 'ssh alice@nexistepas.banquehorizon.com');
    expect(printed(terminal)).toContain('ssh: Could not resolve hostname nexistepas.banquehorizon.com: Name or service not known');
  }, 120000);
});
