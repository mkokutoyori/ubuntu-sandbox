/**
 * `auditd -f` et `-n` gardent le terminal (audit 3.1.2, auditd.c : sans fork le processus reste au premier plan,
 * et en -f les messages vont sur stderr), et audisp-af_unix sert un client reel (audisp/plugins/af_unix/
 * audisp-af_unix.c : un seul client a la fois, « Client connected », les evenements ecrits un par ligne, les autres
 * connexions fermees, un client parti est oublie). Cote client, `nc -U` suit nc OpenBSD mesure sur le binaire reel
 * de l'hote (« nc: PATH: No such file or directory », « Connection refused » pour un fichier socket sans ecoute ou un
 * repertoire, sortie 1) ; la permission d'ecriture sur le fichier socket decide de la connexion. Le demon reel n'a
 * pas pu etre lance : l'oracle du demon est le texte du source. Ctrl-C rend l'invite ici alors que le vrai auditd
 * ignore SIGINT : limite consignee dans TODO.md.
 *
 * Mesure avant : `auditd -f` rendait la main aussitot, `nc -U` etait refuse (« this simulator cannot build UNIX-domain
 * sockets »), le plugin af_unix creait un fichier socket sans personne pour l'ecouter. Avec src/network et src/terminal
 * remis avant, 10 cas sur 13 tombent ; 3 passent dans les deux etats : le temoin (service demarre, pid connu), « un
 * second demon au premier plan echoue aussitot » (le refus ne passe pas par le flux) et « Ctrl-C rend l'invite »
 * (l'invite est deja rendue quand rien ne bloque) ; ils bornent les cas qui bloquent. Le cas `nc -lU` affirmait que la ecoute UNIX restait
 * refusee : la table des prises UNIX existe depuis (probe-prises-unix-une-seule-table), la these etait fausse, il affirme maintenant l'ecoute.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

const key = (k: string, ctrlKey = false): KeyEvent => ({ key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let pc: LinuxPC;
let session: LinuxTerminalSession;

async function typeLine(text: string): Promise<void> {
  session.setInput(text);
  session.handleKey(key('Enter'));
  await flush();
  await flush();
}
const texts = (): string[] => session.lines.map((line) => line.text);

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await pc.executeCommand('sudo su -');
  session = new LinuxTerminalSession('term-1', pc);
});

describe('auditd in the foreground', () => {
  it('witness: the service-started daemon is running with a pid', async () => {
    expect((await pc.executeCommand('pgrep -x auditd')).trim()).toMatch(/^\d+$/);
  });

  it('-f keeps the terminal: startup messages on screen, further input is not executed, then a SIGTERM returns it', async () => {
    await pc.executeCommand('systemctl stop auditd');
    await typeLine('auditd -f');
    expect(texts().some((t) => t.includes('Init complete, auditd 3.1.2 listening for events (startup state enable)'))).toBe(true);
    await typeLine('echo marker-while-blocked');
    expect(texts().some((t) => t === 'marker-while-blocked')).toBe(false);
    await pc.executeCommand('kill -TERM $(cat /var/run/auditd.pid)');
    await flush();
    await typeLine('echo marker-after');
    expect(texts().some((t) => t === 'marker-after')).toBe(true);
  });

  it('-f prints later daemon messages as they happen', async () => {
    await pc.executeCommand('systemctl stop auditd');
    await typeLine('auditd -f');
    await pc.executeCommand('kill -HUP $(cat /var/run/auditd.pid)');
    await flush();
    expect(texts().some((t) => t.includes('config change requested by pid='))).toBe(true);
  });

  it('-n also keeps the terminal, silently (messages go to the journal)', async () => {
    await pc.executeCommand('systemctl stop auditd');
    await typeLine('auditd -n');
    expect(texts().some((t) => t.includes('Init complete'))).toBe(false);
    await typeLine('echo marker-while-blocked');
    expect(texts().some((t) => t === 'marker-while-blocked')).toBe(false);
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('Init complete');
    await pc.executeCommand('kill -TERM $(cat /var/run/auditd.pid)');
  });

  it('a second foreground daemon fails at once and gives the prompt back', async () => {
    await typeLine('auditd -f');
    expect(texts().some((t) => t.includes('Unable to set audit pid, exiting'))).toBe(true);
    await typeLine('echo marker-after');
    expect(texts().some((t) => t === 'marker-after')).toBe(true);
  });

  it('Ctrl-C gives the prompt back and the daemon keeps running', async () => {
    await pc.executeCommand('systemctl stop auditd');
    await typeLine('auditd -f');
    session.handleKey(key('c', true));
    await flush();
    expect((await pc.executeCommand('pgrep -x auditd')).trim()).toMatch(/^\d+$/);
    await typeLine('echo marker-after');
    expect(texts().some((t) => t === 'marker-after')).toBe(true);
  });
});

describe('audisp-af_unix with a real client', () => {
  const SOCKET = '/var/run/audispd_events';
  async function enableAfUnix(): Promise<void> {
    await pc.executeCommand("sed -i 's/^active = no/active = yes/' /etc/audit/plugins.d/af_unix.conf");
    await pc.executeCommand('systemctl restart auditd');
  }

  it('nc -U on a missing path fails like the real nc', async () => {
    expect(await pc.executeCommand('nc -U /nonexistent.sock; echo rc=$?')).toBe('nc: /nonexistent.sock: No such file or directory\nrc=1');
  });

  it('nc -U on a directory or a socket nobody listens on is refused', async () => {
    expect(await pc.executeCommand('nc -U /tmp; echo rc=$?')).toBe('nc: /tmp: Connection refused\nrc=1');
    await enableAfUnix();
    await pc.executeCommand("sed -i 's/^active = yes/active = no/' /etc/audit/plugins.d/af_unix.conf");
    await pc.executeCommand('systemctl restart auditd');
    expect(await pc.executeCommand(`nc -U ${SOCKET}; echo rc=$?`)).toBe(`nc: ${SOCKET}: No such file or directory\nrc=1`);
  });

  it('nc -lU listens now that the socket table exists', async () => {
    await pc.executeCommand('nc -lU /tmp/x.sock &');
    expect(await pc.executeCommand('ls -l /tmp/x.sock | cut -c1')).toBe('s');
    expect(await pc.executeCommand('ss -xl | grep -c x.sock')).toBe('1');
  });

  it('a client receives each event as a line, and the plugin logs the connection', async () => {
    await enableAfUnix();
    await typeLine(`nc -U ${SOCKET}`);
    await pc.executeCommand('auditctl -m streamed');
    await flush();
    expect(texts().some((t) => /type=USER .*text=streamed/.test(t))).toBe(true);
    expect(await pc.executeCommand('grep -c "Client connected" /var/log/syslog')).toBe('1');
  });

  it('only one client at a time: a second connection is closed at once', async () => {
    await enableAfUnix();
    const second = new LinuxTerminalSession('term-2', pc);
    await typeLine(`nc -U ${SOCKET}`);
    second.setInput(`nc -U ${SOCKET}`);
    second.handleKey(key('Enter'));
    await flush();
    await flush();
    await pc.executeCommand('auditctl -m exclusive');
    await flush();
    expect(texts().some((t) => /text=exclusive/.test(t))).toBe(true);
    expect(second.lines.map((line) => line.text).some((t) => /text=exclusive/.test(t))).toBe(false);
  });

  it('a client that leaves is forgotten and the next one is served', async () => {
    await enableAfUnix();
    await typeLine(`nc -U ${SOCKET}`);
    session.handleKey(key('c', true));
    await flush();
    const next = new LinuxTerminalSession('term-3', pc);
    next.setInput(`nc -U ${SOCKET}`);
    next.handleKey(key('Enter'));
    await flush();
    await flush();
    await pc.executeCommand('auditctl -m second-client');
    await flush();
    expect(next.lines.map((line) => line.text).some((t) => /text=second-client/.test(t))).toBe(true);
  });

  it('a user without write permission on the socket file is refused', async () => {
    await enableAfUnix();
    await pc.executeCommand('useradd -m eve');
    expect(await pc.executeCommand(`su eve -c "nc -U ${SOCKET}"; echo rc=$?`)).toContain('Permission denied');
  });
});
