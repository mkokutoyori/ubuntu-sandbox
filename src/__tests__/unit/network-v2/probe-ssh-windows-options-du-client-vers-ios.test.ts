/*
 * `ssh -o KexAlgorithms=+… -o HostKeyAlgorithms=+ssh-rsa` : un client qui lit
 * ses options sur CHACUN des chemins par lesquels une ligne `ssh` arrive.
 *
 * Mesure de depart. Depuis que le serveur IOS 15 negocie ce qu'IOS 15
 * negocie (kex SHA-1, ssh-rsa), un OpenSSH 8.9 n'y entre qu'avec les deux
 * options de compatibilite — c'est le comportement reel — et sept tests de
 * tutoriel qui tapaient `ssh admin@R1` sans option echouaient en « Unable to
 * negotiate ». Les donner a ces tests ne suffisait pas : cinq lignes `ssh`
 * differentes lisaient leurs arguments chacune a sa facon, et quatre
 * IGNORAIENT les `-o` — le terminal Windows (`parseInteractiveSsh`), le
 * lanceur des shells PowerShell/cmd/bash (`parseSshLine`, qui ne retenait
 * que `-p`), le chemin non interactif de Windows (`winWireExecTarget`) et le
 * second saut d'une session SSH (`SshInteractiveSubShell`, dont l'expression
 * reguliere prenait `-o` pour le NOM DE L'HOTE : « connect to host -o port
 * 22 »). Le second saut ignorait aussi `-p`. Quatre lecteurs, une seule
 * grammaire : ils lisent desormais tous `parseSshArgs`/`sshOptionValues`.
 *
 * L'AUTORITE — la page de manuel d'OpenSSH (`ssh(1)`, `ssh_config(5)`) :
 * `-o` donne une option au format de ssh_config, `-p` le port, `-l` le
 * compte distant, et `user@hote` l'emporte sur `-l`. OpenSSH 8.8 et
 * suivants n'offrent plus `ssh-rsa` (signature SHA-1) par defaut ; la
 * version de Win32-OpenSSH (8.6) est celle que le simulateur annonce, et son
 * defaut exact pour l'echange de cles n'est pas attestable d'ici : le
 * simulateur donne aux deux clients les defauts de la 8.9 et les options
 * `+` y ajoutent ce qu'IOS 15 sait faire.
 *
 * Ecrite a l'aveugle, sur les quatre chemins. 7 des 12 cas tombent avant (git
 * stash push -- src/network src/terminal src/shell). Les 5 qui passent des
 * deux cotes : trois TEMOINS (le routeur est refuse avec les defauts du client,
 * au prompt cmd et sous PowerShell, et la session SSH atteint bien le
 * serveur), `-l` au prompt cmd (le terminal Windows le lisait deja), et
 * « runs it on the router » du chemin non interactif — avant, il rendait
 * l'heure du routeur par le raccourci en memoire quand la negociation
 * echouait ; il n'est donc pas la preuve que ses options partaient sur le
 * fil, le cas « is refused by the negotiation » l'est.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

const WIN = '10.0.0.1';
const LINUX = '10.0.0.3';
const ROUTER = '10.0.0.6';
const SECRET = 'Admin@123';
const LEGACY = '-o KexAlgorithms=+diffie-hellman-group14-sha1 -o HostKeyAlgorithms=+ssh-rsa';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  reinstallDefaultShells();
});

async function lab(): Promise<{ win: WindowsPC }> {
  const win = new WindowsPC('windows-pc', 'win', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const mask = new SubnetMask('255.255.255.0');
  [win, server, router].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
  win.getPorts()[0].configureIP(new IPAddress(WIN), mask);
  server.getPorts()[0].configureIP(new IPAddress(LINUX), mask);
  server.setHostname('srv');
  for (const command of [
    'enable', 'configure terminal', 'hostname R1',
    'interface GigabitEthernet0/0', `ip address ${ROUTER} 255.255.255.0`, 'no shutdown', 'exit',
    `username admin privilege 15 secret ${SECRET}`, `enable secret ${SECRET}`,
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
    'line vty 0 4', 'login local', 'transport input ssh', 'end',
  ]) await router.executeCommand(command);
  return { win };
}

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

async function type(terminal: TerminalSession, line: string): Promise<void> {
  terminal.setInput(line);
  terminal.handleKey(key('Enter'));
  await settle();
}

async function typeInside(terminal: TerminalSession, line: string): Promise<void> {
  terminal.setInputBuf(line);
  terminal.handleKey(key('Enter'));
  await settle();
}

async function answerPassword(terminal: TerminalSession, password: string): Promise<void> {
  for (let i = 0; i < 10 && terminal.foreground.currentInputMode.type !== 'password'; i++) await tick();
  if (terminal.foreground.currentInputMode.type === 'password') {
    terminal.setPasswordBuf(password);
    terminal.handleKey(key('Enter'));
  }
  await settle();
}

const transcript = (terminal: TerminalSession): string => terminal.lines.map((line) => line.text).join('\n');

async function windowsTerminal(win: WindowsPC): Promise<WindowsTerminalSession> {
  const terminal = new WindowsTerminalSession('t', win);
  await terminal.init();
  return terminal;
}

describe('the Windows terminal, at the cmd prompt', () => {
  it('refuses an IOS 15 router with the client defaults — WITNESS', async () => {
    const { win } = await lab();
    const terminal = await windowsTerminal(win);
    await type(terminal, `ssh admin@${ROUTER}`);
    await answerPassword(terminal, SECRET);

    expect(transcript(terminal)).toContain(`Unable to negotiate with ${ROUTER} port 22: no matching key exchange method found`);
    expect(terminal.foreground.getPrompt()).toMatch(/^C:\\/);
  });

  it('enters the router once the legacy algorithms are asked for', async () => {
    const { win } = await lab();
    const terminal = await windowsTerminal(win);
    await type(terminal, `ssh ${LEGACY} admin@${ROUTER}`);
    await answerPassword(terminal, SECRET);

    expect(terminal.foreground.getPrompt()).toMatch(/^R1[>#]/);
  });

  it('takes the account from -l when the target has no user@', async () => {
    const { win } = await lab();
    const terminal = await windowsTerminal(win);
    await type(terminal, `ssh ${LEGACY} -l admin ${ROUTER}`);

    expect(terminal.foreground.currentInputMode).toMatchObject({ type: 'password', promptText: `admin@${ROUTER}'s password: ` });
  });
});

describe('PowerShell, whose ssh goes through the shell launcher', () => {
  async function powershell(win: WindowsPC): Promise<WindowsTerminalSession> {
    const terminal = await windowsTerminal(win);
    await type(terminal, 'powershell');
    return terminal;
  }

  it('refuses the router with the client defaults — WITNESS', async () => {
    const { win } = await lab();
    const terminal = await powershell(win);
    await typeInside(terminal, `ssh admin@${ROUTER}`);
    await answerPassword(terminal, SECRET);

    expect(transcript(terminal)).toContain('Unable to negotiate');
    expect(terminal.foreground.getPrompt()).toMatch(/^PS /);
  });

  it('enters the router once the legacy algorithms are asked for', async () => {
    const { win } = await lab();
    const terminal = await powershell(win);
    await typeInside(terminal, `ssh ${LEGACY} admin@${ROUTER}`);
    await answerPassword(terminal, SECRET);

    expect(terminal.foreground.getPrompt()).toMatch(/^R1[>#]/);
  });

  it('asks the password of the account given by -l', async () => {
    const { win } = await lab();
    const terminal = await powershell(win);
    await typeInside(terminal, `ssh ${LEGACY} -l admin ${ROUTER}`);

    expect(terminal.foreground.currentInputMode).toMatchObject({ type: 'password', promptText: `admin@${ROUTER}'s password: ` });
  });
});

describe('the Windows command that runs a remote command', () => {
  it('runs it on the router once the legacy algorithms are asked for', async () => {
    const { win } = await lab();
    const output = await win.executeCommand(`ssh ${LEGACY} admin@${ROUTER} "show clock"`, SECRET);

    expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('is refused by the negotiation with the client defaults', async () => {
    const { win } = await lab();
    const output = await win.executeCommand(`ssh admin@${ROUTER} "show clock"`, SECRET);

    expect(output).toContain(`Unable to negotiate with ${ROUTER} port 22: no matching key exchange method found`);
    expect(output).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

describe('the second hop of an SSH session', () => {
  async function insideServer(win: WindowsPC): Promise<WindowsTerminalSession> {
    const terminal = await windowsTerminal(win);
    await type(terminal, 'ssh alice@' + LINUX);
    await answerPassword(terminal, 'alice');
    return terminal;
  }

  it('is on the server, behind a Linux prompt — WITNESS', async () => {
    const { win } = await lab();
    const terminal = await insideServer(win);

    expect(terminal.foreground.getPrompt()).toMatch(/^alice@srv:/);
  });

  it('reads -o and enters the router instead of taking -o for the host name', async () => {
    const { win } = await lab();
    const terminal = await insideServer(win);
    await typeInside(terminal, `ssh ${LEGACY} admin@${ROUTER}`);
    await answerPassword(terminal, SECRET);

    expect(transcript(terminal)).not.toContain('connect to host -o');
    expect(terminal.foreground.getPrompt()).toMatch(/^R1[>#]/);
  });

  it('says the negotiation failed instead of a permission denial when the defaults do not fit', async () => {
    const { win } = await lab();
    const terminal = await insideServer(win);
    await typeInside(terminal, `ssh admin@${ROUTER}`);
    await answerPassword(terminal, SECRET);

    expect(transcript(terminal)).toContain(`Unable to negotiate with ${ROUTER} port 22`);
    expect(transcript(terminal)).not.toContain('Permission denied');
  });

  it('reads -p and names the port it dialled', async () => {
    const { win } = await lab();
    const terminal = await insideServer(win);
    await typeInside(terminal, `ssh -p 2222 admin@${ROUTER}`);

    expect(transcript(terminal)).toContain(`ssh: connect to host ${ROUTER} port 2222: Connection refused`);
  });
});
