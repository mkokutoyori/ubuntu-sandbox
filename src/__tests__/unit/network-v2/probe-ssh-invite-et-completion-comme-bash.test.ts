/*
 * L'invite et la completion d'une session ssh vers un Linux sont celles
 * d'un bash, comme au terminal local.
 *
 * L'AUTORITE :
 * - bash(1), PROMPTING : l'invite par defaut d'Ubuntu est `\u@\h:\w\$ `,
 *   ou `\w` abrege le HOME en `~` et `\$` s'ecrit `#` quand l'UID effectif
 *   est 0 ;
 * - sudo(8) : `-i` lance le shell de connexion de l'utilisateur cible
 *   (repertoire courant = son HOME, `/root` pour root) ; `-s` lance un
 *   shell sans connexion (le repertoire courant ne change pas) ; avec une
 *   commande, `-i` et `-s` la lancent par ce shell et rendent la main ;
 * - su(1) : `su -` est une connexion (HOME de la cible) ; `exit` rend le
 *   shell a l'utilisateur precedent ;
 * - sshd(8) : la session dure tant que le shell de connexion dure ;
 *   OpenSSH ecrit « Connection to <hote> closed. » quand il se termine ;
 * - bash(1), Pathname Expansion : le resultat d'un motif est trie ;
 * - readline / bash-completion : Tab etend le mot au plus long prefixe
 *   commun, ne liste les candidats que lorsqu'il n'y a plus rien a etendre,
 *   ajoute une espace a un mot unique et `/` a un repertoire unique ; le
 *   premier mot se complete depuis les executables du PATH.
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire les chemins.
 * 12 des 17 cas tombent avant le correctif. Passent des deux cotes les
 * TEMOINS : l'invite de connexion, `sudo -i <commande>`, `exit` d'un
 * shell root local, la seconde `exit` qui ferme la connexion, et un
 * repertoire seul qui se complete avec sa barre oblique — ce dernier
 * prouve que le laboratoire complete bien au terminal local.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface Lab {
  readonly term: LinuxTerminalSession;
  readonly pc1: LinuxPC;
  send(text: string): Promise<void>;
  tab(text: string): Promise<{ input: string; suggestions: readonly string[] | null }>;
  remote(): Promise<void>;
}

async function lab(): Promise<Lab> {
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 100, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  pc1.powerOn();
  pc2.powerOn();
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('eth1')!);
  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await pc1.executeCommand('ping -c 1 10.0.0.2');
  await pc2.executeCommand('ping -c 1 10.0.0.1');
  const tree = 'mkdir -p ~/docs/sub && touch ~/docs/alpha.txt ~/docs/alpine.log ~/docs/beta.txt ~/readme.md';
  await pc1.executeCommand(tree);
  await pc2.executeCommand(tree);
  const term = new LinuxTerminalSession('t1', pc1);
  const send = async (text: string): Promise<void> => {
    if (term.currentInputMode.type === 'password') term.setPasswordBuf(text);
    else {
      term.setInput(text);
      term.setInputBuf(text);
    }
    term.handleKey(key('Enter'));
    await settle();
  };
  let inRemote = false;
  return {
    term,
    pc1,
    send,
    async remote() {
      await send('ssh -o StrictHostKeyChecking=accept-new user@10.0.0.2');
      await send('admin');
      inRemote = true;
    },
    async tab(text: string) {
      (term as unknown as { tabSuggestions: unknown }).tabSuggestions = null;
      term.setInput(text);
      term.setInputBuf(text);
      term.handleKey(key('Tab'));
      await settle();
      return { input: inRemote ? term.getInputBuf() : term.input, suggestions: term.tabSuggestions };
    },
  };
}

describe('sudo opens a root shell', () => {
  it('sudo -i is a login shell: root prompt, HOME of root', async () => {
    const l = await lab();
    await l.send('sudo -i');
    await l.send('admin');

    expect(l.term.getPrompt()).toBe('root@PC1:~# ');
    await l.send('pwd');
    expect(l.term.lines[l.term.lines.length - 1].text).toBe('/root');
  });

  it('sudo -s keeps the directory', async () => {
    const l = await lab();
    await l.send('cd /tmp');
    await l.send('sudo -s');
    await l.send('admin');

    expect(l.term.getPrompt()).toBe('root@PC1:/tmp# ');
  });

  it('exit leaves the root shell for the user prompt — WITNESS', async () => {
    const l = await lab();
    await l.send('sudo su -');
    await l.send('admin');
    await l.send('exit');

    expect(l.term.getPrompt()).toBe('user@PC1:~$ ');
  });

  it('sudo -i with a command runs it and stays the user', async () => {
    const l = await lab();
    await l.send('sudo -i whoami');
    await l.send('admin');

    expect(l.term.lines[l.term.lines.length - 1].text).toBe('root');
    expect(l.term.getPrompt()).toBe('user@PC1:~$ ');
  });
});

describe('over ssh, the prompt follows the shell', () => {
  it('the login prompt names the remote host and the login user — WITNESS', async () => {
    const l = await lab();
    await l.remote();

    expect(l.term.getPrompt()).toBe('user@PC2:~$ ');
  });

  it('sudo -i on the remote gives a root prompt on the remote', async () => {
    const l = await lab();
    await l.remote();
    await l.send('sudo -i');
    await l.send('admin');

    expect(l.term.getPrompt()).toBe('root@PC2:~# ');
  });

  it('su - on the remote goes to the HOME of root', async () => {
    const l = await lab();
    await l.remote();
    await l.send('su -');
    await l.send('admin');

    expect(l.term.getPrompt()).toBe('root@PC2:~# ');
  });

  it('exit in a remote root shell returns to the remote user, not to the local shell', async () => {
    const l = await lab();
    await l.remote();
    await l.send('sudo -i');
    await l.send('admin');
    await l.send('exit');

    expect(l.term.getPrompt()).toBe('user@PC2:~$ ');
    await l.send('echo $SSH_CLIENT');
    expect(l.term.lines[l.term.lines.length - 1].text).toMatch(/^10\.0\.0\.1 \d+ 22$/);
  });

  it('the second exit closes the connection', async () => {
    const l = await lab();
    await l.remote();
    await l.send('exit');

    expect(l.term.getPrompt()).toBe('user@PC1:~$ ');
    expect(l.term.lines.map((line) => line.text)).toContain('Connection to 10.0.0.2 closed.');
  });

  it('a remote bash prompt is coloured like the local one', async () => {
    const l = await lab();
    await l.remote();
    await l.send('sudo -i');
    await l.send('admin');

    expect(l.term.getPromptParts()).toEqual({ user: 'root', hostname: 'PC2', path: '~', promptChar: '#' });
  });
});

describe('over ssh, Tab completes like bash', () => {
  it('extends to the longest common prefix, not to the first candidate', async () => {
    const l = await lab();
    await l.remote();

    expect((await l.tab('cat docs/al')).input).toBe('cat docs/alp');
    expect((await l.tab('syst')).input).toBe('system');
  });

  it('lists the candidates when there is nothing left to extend', async () => {
    const l = await lab();
    await l.remote();
    const out = await l.tab('ls docs/');

    expect(out.input).toBe('ls docs/');
    expect(out.suggestions).toEqual(['docs/alpha.txt', 'docs/alpine.log', 'docs/beta.txt', 'docs/sub/']);
  });

  it('a lone directory takes a slash, a lone file a space — WITNESS of the local terminal', async () => {
    const l = await lab();

    expect((await l.tab('cd do')).input).toBe('cd docs/');
    expect((await l.tab('cat ~/read')).input).toBe('cat ~/readme.md');
  });

  it('the remote answers every one of these exactly as the local terminal does', async () => {
    const inputs = ['cd do', 'cat docs/al', 'cat ~/read', 'ls docs/', 'syst', 'sudo ls /ro', 'echo $HO', 'grep -r foo do'];
    const local = await lab();
    const localAnswers = [];
    for (const input of inputs) localAnswers.push(await local.tab(input));
    const far = await lab();
    await far.remote();
    const remoteAnswers = [];
    for (const input of inputs) remoteAnswers.push(await far.tab(input));

    expect(remoteAnswers).toEqual(localAnswers);
  });
});

describe('the first word comes from the PATH', () => {
  it('the ssh tools complete, and are on disk', async () => {
    const l = await lab();

    expect((await l.tab('ssh-keyg')).input).toBe('ssh-keygen ');
    expect((await l.tab('ssh-cop')).input).toBe('ssh-copy-id ');
    expect(await l.pc1.executeCommand('which ssh-keygen')).toBe('/usr/bin/ssh-keygen');
    expect(await l.pc1.executeCommand('ls /usr/bin/ssh-*')).toBe(
      ['/usr/bin/ssh-add', '/usr/bin/ssh-agent', '/usr/bin/ssh-copy-id', '/usr/bin/ssh-keygen', '/usr/bin/ssh-keyscan'].join('\n'),
    );
  });

  it('a registered command completes too', async () => {
    const l = await lab();

    expect((await l.tab('ngin')).input).toBe('nginx ');
  });

  it('a host is completed after user@', async () => {
    const l = await lab();

    expect((await l.tab('ssh user@10.0.0.')).input).toBe('ssh user@10.0.0.2');
  });
});
