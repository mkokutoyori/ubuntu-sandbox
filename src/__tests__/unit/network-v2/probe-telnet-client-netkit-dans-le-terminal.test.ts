/*
 * Sonde — le client telnet du terminal Linux est le moteur netkit, pas une copie du BSD.
 *
 * Mesure AVANT, sur un LinuxPC qui tape `telnet` dans son terminal :
 *   `telnet`                      -> "usage: telnet host-name [port]" (l'invite `telnet>` n'existait pas)
 *   `telnet 10.0.0.20 1`          -> "telnet: connect to address 10.0.0.20: Connection refused" (netkit dit
 *                                    "telnet: Unable to connect to remote host: Connection refused")
 *   `telnet -l alice 10.0.0.20`   -> l'option `-l` etait filtree sans effet (aucune variable USER exportee)
 *   Ctrl+] puis `status`          -> rien : la touche d'echappement n'existait pas
 *
 * HUIT cas sur dix tombent avant le branchement. Les deux autres sont NOMMES : le temoin (le serveur repond bien sur :23, donc
 * un echec ailleurs est celui du client) et la non-regression (une session de bout en bout, login puis commande, tient toujours).
 * Les mots viennent du binaire netkit-telnet 0.17 enregistre (telnet-client-netkit-oracle.test.ts), pas du BSD.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const MASK = new SubnetMask('255.255.255.0');
const SERVER_IP = '10.0.0.20';

function key(k: string, ctrl = false): KeyEvent {
  return { key: k, ctrlKey: ctrl, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Typing {
  setInput(text: string): void;
  setInputBuf(text: string): void;
  handleKey(e: KeyEvent): boolean;
  lines: ReadonlyArray<{ text: string }>;
  getPrompt?(): string;
}

async function type(term: Typing, text: string): Promise<void> {
  term.setInput(text);
  term.setInputBuf(text);
  term.handleKey(key('Enter'));
  await flush();
}

async function press(term: Typing, k: string): Promise<void> {
  term.handleKey(key(k, true));
  await flush();
}

function screen(term: Typing): string {
  return term.lines.map((l) => l.text).join('\n');
}

async function buildLan(): Promise<{ pc: LinuxPC; server: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alicesecret');
  await server.executeCommand('systemctl start telnet');
  return { pc, server };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('le terminal Linux parle avec le client netkit-telnet', () => {
  it('témoin : le serveur répond sur :23', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, `telnet ${SERVER_IP}`);
    expect(screen(term)).toContain(`Connected to ${SERVER_IP}.`);
    expect(term.getPrompt()).toMatch(/login: $/);
  });

  it('`telnet` seul ouvre l\'invite telnet> et `quit` en sort', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, 'telnet');
    expect(term.getPrompt()).toBe('telnet> ');
    await type(term, 'quit');
    expect(term.getPrompt()).not.toBe('telnet> ');
  });

  it('`?` liste les commandes comme netkit', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, 'telnet');
    await type(term, '?');
    expect(screen(term)).toContain('Commands may be abbreviated.  Commands are:');
    expect(screen(term)).toContain("close   \tclose current connection");
  });

  it('un port refusé se dit avec les mots de netkit', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, `telnet ${SERVER_IP} 1`);
    expect(screen(term)).toContain(`Trying ${SERVER_IP}...`);
    expect(screen(term)).toContain('telnet: Unable to connect to remote host: Connection refused');
  });

  it('un nom inconnu se dit avec les mots de getaddrinfo', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, 'telnet nowhere.invalid');
    expect(screen(term)).toContain('telnet: could not resolve nowhere.invalid/telnet: Name or service not known');
  });

  it('une option inconnue affiche le usage de netkit', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, 'telnet -z');
    expect(screen(term)).toContain("telnet: invalid option -- 'z'");
    expect(screen(term)).toContain('Usage: telnet [-4] [-6] [-8] [-E] [-L] [-a] [-d] [-e char] [-l user]');
  });

  it('ouvre une session de bout en bout et exécute une commande', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, `telnet ${SERVER_IP}`);
    await type(term, 'alice');
    await type(term, 'alicesecret');
    await type(term, 'whoami');
    expect(screen(term)).toMatch(/\nalice\n/);
  });

  it('Ctrl+] ouvre l\'invite de commande, `status` répond, puis la session reprend', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, `telnet ${SERVER_IP}`);
    await press(term, ']');
    expect(term.getPrompt()).toBe('telnet> ');
    await type(term, 'status');
    expect(screen(term)).toContain(`Connected to ${SERVER_IP}.`);
    expect(screen(term)).toContain("Escape character is '^]'.");
    await type(term, 'alice');
    await type(term, 'alicesecret');
    await type(term, 'whoami');
    expect(screen(term)).toMatch(/\nalice\n/);
  });

  it('`close` depuis l\'invite ferme la connexion et rend le shell', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, `telnet ${SERVER_IP}`);
    await press(term, ']');
    await type(term, 'close');
    expect(screen(term)).toContain('Connection closed.');
    expect(term.getPrompt()).not.toBe('telnet> ');
  });

  it('`exit` côté serveur rend `Connection closed by foreign host.`', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t', pc);
    await type(term, `telnet ${SERVER_IP}`);
    await type(term, 'alice');
    await type(term, 'alicesecret');
    await type(term, 'exit');
    expect(screen(term)).toContain('Connection closed by foreign host.');
  });
});
