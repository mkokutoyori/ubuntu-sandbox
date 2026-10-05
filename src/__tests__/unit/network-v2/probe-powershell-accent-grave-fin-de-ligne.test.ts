/*
 * Un accent grave (`) en DERNIER caractere d'une ligne PowerShell dit que la
 * commande continue a la ligne suivante : la console rend l'invite de
 * continuation `>> `, accumule les lignes, et n'execute que la commande
 * entiere. Le meme comportement tient quand on arrive sur la machine par SSH.
 *
 * Mesure de depart : le lexeur sait deja joindre « ` » + saut de ligne dans un
 * texte multi-lignes, mais le terminal remet CHAQUE ligne a l'interprete des
 * qu'on appuie sur Entree. Une commande coupee par un accent grave s'executait
 * donc en deux morceaux, tous deux faux : `Write-Output ``` rendait une erreur
 * de syntaxe, puis `"bonjour"` s'affichait seul. Le shell empile des sessions
 * SSH (`AbstractShell`) allait plus loin : il ROGNAIT la ligne avant de la
 * distribuer, donc « ` » suivi d'un espace devenait « ` » en fin de ligne, et
 * une ligne vide en cours de continuation etait avalee avant l'interprete.
 *
 * L'AUTORITE — la documentation Microsoft, about_Special_Characters,
 * « Backtick (`) » : un accent grave en fin de ligne continue la commande sur
 * la suivante, a condition d'etre le DERNIER caractere de la ligne ; suivi
 * d'un espace, il echappe cet espace et la ligne est complete. Deux accents
 * graves de suite sont un accent grave litteral. La console (PSReadLine) rend
 * l'invite `>> ` pour toute entree incomplete, et une ligne vide en fin de
 * continuation envoie la commande.
 *
 * Ecrite a l'aveugle, sur quatre chemins qui aboutissent au meme interprete :
 * le sous-shell local, le terminal graphique de Windows, une session SSH
 * pilotee par entree standard (de Windows et de Linux) vers un Windows ou l'on
 * tape `powershell`, et la meme session tapee dans un terminal graphique.
 *
 * 10 des 22 cas tombent avant (git stash push -- src/powershell src/terminal
 * src/shell) : l'invite de continuation, l'accumulation sur plusieurs lignes,
 * un parametre et sa valeur de part et d'autre de la coupure, l'espace apres
 * l'accent grave, la ligne vide qui envoie, l'echo `>> ` du terminal, et la
 * jonction par SSH depuis Windows, depuis Linux, puis dans un terminal
 * graphique de chaque systeme. Les 12 qui passent des deux cotes : trois
 * TEMOINS (une ligne complete, l'entree dans PowerShell, une commande SSH
 * d'une ligne) ; trois NON-REGRESSIONS (l'accent grave dans un commentaire,
 * deux accents graves, l'espace apres l'accent grave par SSH) ; et six cas
 * qui ne lisent que la SORTIE finale — avant la correction la moitie de
 * commande affichait un accent grave au lieu d'echouer, si bien que
 * « imprime le resultat une fois », « aucune erreur de syntaxe » et
 * « la ligne vide termine » (SSH) ne separent pas l'avant de l'apres ; ils
 * gardent la sortie, les deux premiers cas du terminal et celui de
 * l'historique gardent le reste.
 *
 * Trouve en chemin : `PSLexer.scanWord` testait l'arret de mot AVANT
 * l'echappement par accent grave, donc un accent grave en DEBUT de mot —
 * « ` » suivi d'un espace — n'etait pas un echappement mais un mot « ` » a
 * part. La sortie de `Write-Output "x" ` ` etait « x » puis « ` » ; elle est
 * « x » puis une espace, comme sur PowerShell.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const WIN_IP = '10.0.0.2';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const BACKTICK = '`';

describe('the PowerShell sub-shell', () => {
  async function shell() {
    const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    const { subShell } = PowerShellSubShell.create(win);
    return subShell;
  }

  it('runs a complete line at once — WITNESS', async () => {
    const ps = await shell();
    const result = await ps.processLine('Write-Output "bonjour"');

    expect(result.output).toEqual(['bonjour']);
    expect(ps.getPrompt()).toMatch(/^PS .*> $/);
  });

  it('holds a line that ends with a backtick and shows the continuation prompt', async () => {
    const ps = await shell();
    const result = await ps.processLine(`Write-Output ${BACKTICK}`);

    expect(result.output).toEqual([]);
    expect(result.prompt).toBe('>> ');
    expect(ps.getPrompt()).toBe('>> ');
  });

  it('runs the whole command once the last line has no backtick, and restores the prompt', async () => {
    const ps = await shell();
    await ps.processLine(`Write-Output ${BACKTICK}`);
    const result = await ps.processLine('"bonjour"');

    expect(result.output).toEqual(['bonjour']);
    expect(ps.getPrompt()).toMatch(/^PS .*> $/);
  });

  it('chains as many continuations as the command needs', async () => {
    const ps = await shell();
    await ps.processLine(`Write-Output ${BACKTICK}`);
    await ps.processLine(`  "alpha" ${BACKTICK}`);
    const result = await ps.processLine('  "beta"');

    expect(result.output).toEqual(['alpha', 'beta']);
  });

  it('keeps a parameter and its value together across the break', async () => {
    const ps = await shell();
    await ps.processLine(`Join-Path -Path C: ${BACKTICK}`);
    const result = await ps.processLine('  -ChildPath Users');

    expect(result.output).toEqual(['C:\\Users']);
  });

  it('does not continue when a space follows the backtick', async () => {
    const ps = await shell();
    const result = await ps.processLine(`Write-Output "bonjour" ${BACKTICK} `);

    expect(result.output.filter(line => line.trim() !== '')).toEqual(['bonjour']);
    expect(ps.getPrompt()).toMatch(/^PS .*> $/);
  });

  it('does not continue after two backticks, which are one literal backtick', async () => {
    const ps = await shell();
    const result = await ps.processLine(`Write-Output "a"${BACKTICK}${BACKTICK}`);

    expect(ps.getPrompt()).toMatch(/^PS .*> $/);
    expect(result.prompt).toMatch(/^PS .*> $/);
  });

  it('does not continue on a backtick inside a comment', async () => {
    const ps = await shell();
    const result = await ps.processLine(`Write-Output "ok" # note ${BACKTICK}`);

    expect(result.output).toEqual(['ok']);
    expect(ps.getPrompt()).toMatch(/^PS .*> $/);
  });

  it('runs the command on an empty line while a continuation is open', async () => {
    const ps = await shell();
    await ps.processLine(`Write-Output "bonjour" ${BACKTICK}`);
    const result = await ps.processLine('');

    expect(result.output).toEqual(['bonjour']);
    expect(ps.getPrompt()).toMatch(/^PS .*> $/);
  });

  it('records the joined command once in the history', async () => {
    const ps = await shell();
    await ps.processLine(`Write-Output ${BACKTICK}`);
    await ps.processLine('"bonjour"');
    const history = await ps.processLine('Get-History');

    expect(history.output.join('\n').match(/Write-Output/g)?.length).toBe(1);
  });
});

describe('the graphical Windows terminal', () => {
  const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  const tick = () => new Promise<void>((r) => setTimeout(r, 40));
  const texts = (s: WindowsTerminalSession): string[] => s.lines.map((l) => l.text);

  async function powershellTerminal() {
    const win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    win.powerOn();
    const session = new WindowsTerminalSession('term-1', win);
    await session.init?.();
    session.setInput('powershell');
    session.handleKey(key('Enter'));
    await new Promise((r) => setTimeout(r, 80));
    return session;
  }

  async function enter(session: WindowsTerminalSession, line: string): Promise<void> {
    session.setInputBuf(line);
    session.handleKey(key('Enter'));
    await tick();
  }

  it('enters PowerShell — WITNESS', async () => {
    const session = await powershellTerminal();

    expect(session.shellMode).toBe('powershell');
  });

  it('echoes the continuation line behind the >> prompt', async () => {
    const session = await powershellTerminal();
    await enter(session, `Write-Output ${BACKTICK}`);
    await enter(session, '"bonjour"');
    const [first, second] = session.lines.filter(line => line.type === 'prompt').slice(-2);

    expect(`${first.promptText}${first.text}`).toMatch(new RegExp(`^PS .*> Write-Output ${BACKTICK}$`));
    expect(`${second.promptText}${second.text}`).toBe('>> "bonjour"');
  });

  it('prints the result once, after the last line', async () => {
    const session = await powershellTerminal();
    await enter(session, `Write-Output ${BACKTICK}`);
    expect(texts(session).filter(line => line === 'bonjour')).toEqual([]);
    await enter(session, '"bonjour"');

    expect(texts(session).filter(line => line === 'bonjour')).toEqual(['bonjour']);
  });

  it('never shows a syntax error for the half command', async () => {
    const session = await powershellTerminal();
    await enter(session, `Write-Output ${BACKTICK}`);
    await enter(session, '"bonjour"');

    expect(texts(session).join('\n')).not.toMatch(/ParserError|Missing|Unexpected|syntax/i);
  });

  it('keeps the streaming interceptors on the whole command, not on its first fragment', async () => {
    const session = await powershellTerminal();
    await enter(session, `Write-Output ${BACKTICK}`);
    await enter(session, '"-n 3 ping"');

    expect(texts(session)).toContain('-n 3 ping');
  });
});

describe('a PowerShell reached over SSH', () => {
  async function lab() {
    const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    const client = new WindowsPC('windows-pc', 'WIN2', 0, 0);
    const pc = new LinuxPC('linux-pc', 'P1');
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
    new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
    new Cable('c3').connect(client.getPorts()[0], sw.getPorts()[2]);
    pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
    win.getPorts()[0].configureIP(new IPAddress(WIN_IP), MASK);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
    await settle();
    return { pc, client };
  }

  const session = (...lines: string[]): string => `user\npowershell\n${lines.join('\n')}\nexit\nexit\n`;

  it('answers a single-line command — WITNESS', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`ssh -o StrictHostKeyChecking=accept-new User@${WIN_IP}`, session('Write-Output "bonjour"'));

    expect(out).toContain('bonjour');
  }, 30000);

  it('joins a backtick continuation from a Windows client', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`ssh -o StrictHostKeyChecking=accept-new User@${WIN_IP}`, session(`Write-Output ${BACKTICK}`, '"bonjour"'));

    expect(out).toContain('>> "bonjour"');
    expect(out.split('\n').filter(line => line.trim() === 'bonjour')).toEqual(['bonjour']);
  }, 30000);

  it('joins a backtick continuation from a Linux client', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`ssh -o StrictHostKeyChecking=accept-new User@${WIN_IP}`, session(`Write-Output ${BACKTICK}`, '"bonjour"'));

    expect(out).toContain('>> "bonjour"');
    expect(out.split('\n').filter(line => line.trim() === 'bonjour')).toEqual(['bonjour']);
  }, 30000);

  it('treats a backtick followed by a space as a complete line', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`ssh -o StrictHostKeyChecking=accept-new User@${WIN_IP}`, session(`Write-Output "bonjour" ${BACKTICK} `));

    expect(out.split('\n').filter(line => line.trim() === 'bonjour')).toEqual(['bonjour']);
    expect(out).not.toContain('>> ');
  }, 30000);

  it('ends the continuation on an empty line', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`ssh -o StrictHostKeyChecking=accept-new User@${WIN_IP}`, session(`Write-Output "bonjour" ${BACKTICK}`, ''));

    expect(out.split('\n').filter(line => line.trim() === 'bonjour')).toEqual(['bonjour']);
  }, 30000);
});

describe('a PowerShell reached over SSH from a graphical terminal', () => {
  const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  const tick = () => new Promise<void>((r) => setTimeout(r, 40));

  async function loggedIn(clientKind: 'windows' | 'linux') {
    const server = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    const client = clientKind === 'windows'
      ? new WindowsPC('windows-pc', 'WIN2', 0, 0)
      : new LinuxPC('linux-pc', 'P1');
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
    server.getPorts()[0].configureIP(new IPAddress(WIN_IP), MASK);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
    client.powerOn();
    server.powerOn();
    await settle();
    const session: TerminalSession = clientKind === 'windows'
      ? new WindowsTerminalSession('term', client as WindowsPC)
      : new LinuxTerminalSession('term', client as LinuxPC);
    await session.init?.();
    session.setInput(`ssh -o StrictHostKeyChecking=accept-new User@${WIN_IP}`);
    session.handleKey(key('Enter'));
    for (let i = 0; i < 8 && session.currentInputMode.type !== 'password'; i++) await tick();
    session.setPasswordBuf('user');
    session.handleKey(key('Enter'));
    for (let i = 0; i < 8; i++) await tick();
    return session;
  }

  async function typeLine(session: TerminalSession, line: string): Promise<void> {
    session.setInput(line);
    session.setInputBuf(line);
    session.handleKey(key('Enter'));
    for (let i = 0; i < 4; i++) await tick();
  }

  it.each(['windows', 'linux'] as const)('a %s terminal shows the >> prompt and runs the joined command', async (kind) => {
    const session = await loggedIn(kind);
    await typeLine(session, 'powershell');
    await typeLine(session, `Write-Output ${BACKTICK}`);
    const promptAfterFirstLine = session.getPrompt();
    await typeLine(session, '"bonjour"');
    const lines = session.lines.map(line => line.text);

    expect(promptAfterFirstLine).toBe('>> ');
    expect(lines.filter(line => line === 'bonjour')).toEqual(['bonjour']);
  }, 60000);
});
