/*
 * Le client SSH choisit ses methodes d'authentification comme OpenSSH.
 *
 * L'AUTORITE EST OPENSSH 8.9p1 (Ubuntu 22.04), lu dans
 * openssh-portable, etiquette V_8_9_P1 :
 * - `sshconnect2.c` : le client ouvre par une requete « none » ; chaque
 *   refus du serveur porte la liste des methodes qui peuvent continuer,
 *   et `authmethod_get` prend, dans l'ordre de PreferredAuthentications,
 *   la premiere methode que le serveur annonce et que le client a
 *   activee. L'ordre par defaut est celui de la table : publickey,
 *   keyboard-interactive, password. `BatchMode` desactive les deux
 *   dernieres. `NumberOfPasswordPrompts` (3) borne chacune. Le mot de
 *   passe s'invite par « user@host's password: », et « Permission denied,
 *   please try again. » ne s'ecrit qu'entre deux invites ;
 *   keyboard-interactive affiche l'invite du SERVEUR sous la forme
 *   « (user@host) <invite> ». Quand plus rien ne reste : « user@host:
 *   Permission denied (<liste du serveur>). » ;
 * - `auth2.c` : sshd annonce ses methodes activees dans l'ordre de sa
 *   table (publickey, password, keyboard-interactive), ne compte pas le
 *   premier « none », compte tout autre echec, et coupe au MaxAuthTries-
 *   ieme par « Too many authentication failures » ; le client ecrit
 *   alors « Received disconnect from <ip> port <port>:2: … » puis
 *   « Disconnected from <ip> port <port> » ;
 * - `readconf.c` : les identites par defaut sont, dans cet ordre,
 *   id_rsa, id_ecdsa, id_ecdsa_sk, id_ed25519, id_ed25519_sk, id_xmss,
 *   id_dsa ;
 * - PAM (pam_unix) invite keyboard-interactive par « Password: ».
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire le client. Un
 * seul cas a change apres coup, et pour une raison de laboratoire : le
 * fail2ban du simulateur (maxretry 5) bannissait la source avant le
 * MaxAuthTries 6 d'OpenSSH. Le cas regle donc MaxAuthTries a 4, pour que
 * la coupure vienne du serveur SSH et non du pare-feu.
 *
 * Discriminee contre l'etat d'avant (f65b09b8c) : 12 des 17 cas
 * tombent. Passent des deux cotes :
 *  - les quatre TEMOINS : trois mauvais mots de passe finissent sur la
 *    liste du serveur par defaut, une cle autorisee ouvre la session sans
 *    invite au terminal comme dans un script, et BatchMode dans un script
 *    devant le serveur par defaut cite `(publickey,password)`. Sans eux,
 *    une sonde de refus ne prouverait rien du laboratoire ;
 *  - `KbdInteractiveAuthentication=no` laisse l'invite du mot de passe :
 *    l'ancien client ne connaissait que celle-la. Il garde le correctif
 *    honnete, qui ne doit pas proposer keyboard-interactive quand
 *    l'option le retire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

const SERVER = '10.0.0.2';
const PASSWORD_PROMPT = `alice@${SERVER}'s password: `;
const KBD_PROMPT = `(alice@${SERVER}) Password: `;

interface Lab { client: LinuxPC; server: LinuxServer; term: LinuxTerminalSession }

async function buildLab(sshd: { password?: 'yes' | 'no'; kbd?: 'yes' | 'no'; maxAuthTries?: number } = {}): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress(SERVER), mask);
  await server.executeCommand('sudo useradd -m -s /bin/bash alice');
  await server.executeCommand('echo "alice:s3cret" | sudo chpasswd');
  const edits: string[] = [];
  if (sshd.password) edits.push(`s/^PasswordAuthentication.*/PasswordAuthentication ${sshd.password}/`);
  if (sshd.kbd) edits.push(`s/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication ${sshd.kbd}/`);
  if (sshd.maxAuthTries) edits.push(`s/^MaxAuthTries.*/MaxAuthTries ${sshd.maxAuthTries}/`);
  for (const edit of edits) await server.executeCommand(`sudo sed -i '${edit}' /etc/ssh/sshd_config`);
  await server.executeCommand('sudo systemctl restart ssh');
  await client.executeCommand(`ping -c 1 ${SERVER}`);
  return { client, server, term: new LinuxTerminalSession('term-1', client) };
}

async function authorize(lab: Lab, publicKeyFiles: Record<string, string>): Promise<void> {
  const lines: string[] = [];
  for (const [file, forced] of Object.entries(publicKeyFiles)) {
    const pub = (await lab.client.executeCommand(`cat ~/.ssh/${file}`)).trim();
    lines.push(forced ? `command="echo ${forced}" ${pub}` : pub);
  }
  await lab.server.executeCommand('sudo mkdir -p /home/alice/.ssh');
  await lab.server.executeCommand(`printf '%s\\n' ${lines.map((l) => `'${l.replace(/'/g, `'\\''`)}'`).join(' ')} | sudo tee /home/alice/.ssh/authorized_keys`);
  await lab.server.executeCommand('sudo chown -R alice:alice /home/alice/.ssh');
  await lab.server.executeCommand('sudo chmod 700 /home/alice/.ssh');
  await lab.server.executeCommand('sudo chmod 600 /home/alice/.ssh/authorized_keys');
}

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

const texts = (term: LinuxTerminalSession) => term.lines.map((l) => l.text);
const denied = (term: LinuxTerminalSession) => texts(term).find((l) => /Permission denied \(/.test(l)) ?? null;
const promptOf = (term: LinuxTerminalSession) => {
  const mode = term.currentInputMode;
  return mode.type === 'password' ? mode.promptText : null;
};

async function type(term: LinuxTerminalSession, line: string): Promise<void> {
  term.setInput(line);
  term.setInputBuf(line);
  term.handleKey(key('Enter'));
  await flush();
}

async function answerEveryPrompt(term: LinuxTerminalSession, answer: string, until: () => boolean): Promise<string[]> {
  const prompts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ready = await waitFor(() => until() || promptOf(term) !== null);
    if (!ready || until()) break;
    prompts.push(promptOf(term)!);
    term.setPasswordBuf(answer);
    term.handleKey(key('Enter'));
    await flush();
  }
  return prompts;
}

describe('the client offers only what the server advertises', () => {
  it('three wrong passwords end on the server list — WITNESS', async () => {
    const { term } = await buildLab();
    await type(term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER}`);
    const prompts = await answerEveryPrompt(term, 'wrong', () => denied(term) !== null);

    expect(prompts).toEqual([PASSWORD_PROMPT, PASSWORD_PROMPT, PASSWORD_PROMPT]);
    expect(denied(term)).toBe(`alice@${SERVER}: Permission denied (publickey,password).`);
  });

  it('a server without password authentication is never asked for one', async () => {
    const { term } = await buildLab({ password: 'no' });
    await type(term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER}`);
    const prompts = await answerEveryPrompt(term, 'wrong', () => denied(term) !== null);

    expect(prompts).toEqual([]);
    expect(denied(term)).toBe(`alice@${SERVER}: Permission denied (publickey).`);
  });

  it('keyboard-interactive shows the server prompt and opens the session', async () => {
    const { term } = await buildLab({ password: 'no', kbd: 'yes' });
    await type(term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER}`);
    const prompts = await answerEveryPrompt(term, 's3cret', () => term.isInsideSshSession);

    expect(prompts).toEqual([KBD_PROMPT]);
    expect(term.isInsideSshSession).toBe(true);
  });

  it('keyboard-interactive comes before password when the server offers both', async () => {
    const { term } = await buildLab({ kbd: 'yes' });
    await type(term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER}`);
    await waitFor(() => promptOf(term) !== null);

    expect(promptOf(term)).toBe(KBD_PROMPT);
  });

  it('MaxAuthTries 4: three keyboard-interactive prompts, one password prompt, then the server disconnects', async () => {
    const { term } = await buildLab({ kbd: 'yes', maxAuthTries: 4 });
    await type(term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER}`);
    const gone = () => texts(term).some((l) => l.startsWith('Received disconnect'));
    const prompts = await answerEveryPrompt(term, 'wrong', () => gone() || denied(term) !== null);

    expect(prompts).toEqual([KBD_PROMPT, KBD_PROMPT, KBD_PROMPT, PASSWORD_PROMPT]);
    expect(texts(term)).not.toContain('Permission denied, please try again.');
    expect(texts(term)).toContain(`Received disconnect from ${SERVER} port 22:2: Too many authentication failures`);
    expect(texts(term)).toContain(`Disconnected from ${SERVER} port 22`);
    expect(denied(term)).toBeNull();
  });
});

describe('the client options decide which methods it tries', () => {
  it('KbdInteractiveAuthentication=no leaves the password prompt — passes either way', async () => {
    const { term } = await buildLab({ kbd: 'yes' });
    await type(term, `ssh -o StrictHostKeyChecking=accept-new -o KbdInteractiveAuthentication=no alice@${SERVER}`);
    await waitFor(() => promptOf(term) !== null);

    expect(promptOf(term)).toBe(PASSWORD_PROMPT);
  });

  it('PasswordAuthentication=no still allows keyboard-interactive', async () => {
    const { term } = await buildLab({ kbd: 'yes' });
    await type(term, `ssh -o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no alice@${SERVER}`);
    await waitFor(() => promptOf(term) !== null);

    expect(promptOf(term)).toBe(KBD_PROMPT);
  });

  it('PreferredAuthentications=password does not offer the key', async () => {
    const lab = await buildLab();
    await lab.client.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519");
    await authorize(lab, { 'id_ed25519.pub': '' });
    await type(lab.term, `ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password alice@${SERVER}`);
    await waitFor(() => promptOf(lab.term) !== null || lab.term.isInsideSshSession);

    expect(promptOf(lab.term)).toBe(PASSWORD_PROMPT);
  });

  it('PubkeyAuthentication=no does not offer the key', async () => {
    const lab = await buildLab();
    await lab.client.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519");
    await authorize(lab, { 'id_ed25519.pub': '' });
    await type(lab.term, `ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no alice@${SERVER}`);
    await waitFor(() => promptOf(lab.term) !== null || lab.term.isInsideSshSession);

    expect(promptOf(lab.term)).toBe(PASSWORD_PROMPT);
  });

  it('an authorized key opens the session without a prompt — WITNESS', async () => {
    const lab = await buildLab();
    await lab.client.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519");
    await authorize(lab, { 'id_ed25519.pub': '' });
    await type(lab.term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER}`);
    await waitFor(() => promptOf(lab.term) !== null || lab.term.isInsideSshSession);

    expect(lab.term.isInsideSshSession).toBe(true);
  });

  it('NumberOfPasswordPrompts=1 asks once', async () => {
    const { term } = await buildLab();
    await type(term, `ssh -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 alice@${SERVER}`);
    const prompts = await answerEveryPrompt(term, 'wrong', () => denied(term) !== null);

    expect(prompts).toEqual([PASSWORD_PROMPT]);
    expect(texts(term)).not.toContain('Permission denied, please try again.');
    expect(denied(term)).toBe(`alice@${SERVER}: Permission denied (publickey,password).`);
  });

  it('BatchMode=yes never prompts', async () => {
    const { term } = await buildLab();
    await type(term, `ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes alice@${SERVER}`);
    const prompts = await answerEveryPrompt(term, 'wrong', () => denied(term) !== null);

    expect(prompts).toEqual([]);
    expect(denied(term)).toBe(`alice@${SERVER}: Permission denied (publickey,password).`);
  });
});

describe('default identities are tried in OpenSSH order', () => {
  it('id_rsa is offered before id_ed25519', async () => {
    const lab = await buildLab();
    await lab.client.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519");
    await lab.client.executeCommand("ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa");
    await authorize(lab, { 'id_ed25519.pub': 'by-ed25519', 'id_rsa.pub': 'by-rsa' });
    await type(lab.term, `ssh -o StrictHostKeyChecking=accept-new alice@${SERVER} hostname`);
    await waitFor(() => texts(lab.term).some((l) => /^by-/.test(l)));

    expect(texts(lab.term).filter((l) => /^by-/.test(l))).toEqual(['by-rsa']);
  });
});

describe('a script sees the list the server advertised', () => {
  it('BatchMode against a server without passwords names keyboard-interactive', async () => {
    const { client } = await buildLab({ password: 'no', kbd: 'yes' });
    const out = await client.executeCommand(`ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes alice@${SERVER} true`);

    expect(out).toContain(`alice@${SERVER}: Permission denied (publickey,keyboard-interactive).`);
  });

  it('an authorized key opens the session in a script — WITNESS', async () => {
    const lab = await buildLab();
    await lab.client.executeCommand("ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa");
    await authorize(lab, { 'id_rsa.pub': '' });

    expect(await lab.client.executeCommand(`ssh alice@${SERVER} whoami`)).toMatch(/^alice$/m);
  });

  it('PreferredAuthentications=password in a script does not offer the key', async () => {
    const lab = await buildLab();
    await lab.client.executeCommand("ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa");
    await authorize(lab, { 'id_rsa.pub': '' });
    const out = await lab.client.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password alice@${SERVER} whoami`, 'wrong\n');

    expect(out).not.toMatch(/^alice$/m);
  });

  it('BatchMode against the default server — WITNESS', async () => {
    const { client } = await buildLab();
    const out = await client.executeCommand(`ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes alice@${SERVER} true`);

    expect(out).toContain(`alice@${SERVER}: Permission denied (publickey,password).`);
  });
});
