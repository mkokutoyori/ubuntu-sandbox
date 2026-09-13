/**
 * Windows livre les outils OpenSSH, et une machine n'a QU'UN ssh-keygen.
 *
 * Deux questions dans une seule sonde, parce qu'elles ont la meme cause :
 * le depot porte DEUX generateurs de cles qui ne repondent pas pareil, et
 * le poste Windows n'est branche sur aucun des deux.
 *
 * Autorite pour la premiere moitie : le manifeste de charge utile du
 * constructeur lui-meme, `contrib/win32/openssh/OpenSSHBuildHelper.psm1`
 * l. 320-321 du depot `PowerShell/openssh-portable`, qui enumere ce que
 * le paquet OpenSSH-Win64 embarque :
 *
 *   sshd.exe, sshd-auth.exe, sshd-session.exe, ssh.exe, ssh-agent.exe,
 *   ssh-add.exe, sftp.exe, sftp-server.exe, scp.exe, ssh-shellhost.exe,
 *   ssh-keygen.exe, ssh-keyscan.exe, ssh-sk-helper.exe, ssh-pkcs11-helper.exe
 *
 * `ssh-copy-id` n'y figure pas : c'est un script du repertoire `contrib`,
 * jamais compile. Son absence est donc un TEMOIN — elle prouve que la
 * repartition des commandes decide vraiment, au lieu de tout accepter.
 *
 * Les formats de sortie viennent du CODE de ce meme fork, qui ne devie pas
 * d'amont sur ce point :
 *
 *   ssh-agent.c    l. 2456  "%s=%s; export %s;\n"  /  "setenv %s %s;\n"
 *   ssh-agent.c    l. 2461  "echo Agent pid %ld;\n"
 *   ssh-add.c      l. 543   "The agent has no identities.\n"
 *   ssh-keygen.c   l. 3936  "Your identification has been saved in %s\n"
 *   ssh-keyscan.c  l. 665   la ligne d'usage
 *
 * Seconde moitie — la coherence. `ssh-keygen` tape dans le terminal de
 * l'interface et `ssh-keygen` arrive par SSH sont DEUX VUES d'un meme
 * outil sur une meme machine ; elles doivent repondre la meme chose au
 * meme instant. Les cas la-dessous comparent les deux vues sans nommer
 * laquelle a tort.
 *
 * Mesure avant correction : 12 cas tombent sur 15.
 * Les 3 qui passent des deux cotes, et pourquoi :
 *   - « ssh-copy-id reste absent de Windows » : TEMOIN, il prouve que la
 *     repartition refuse ce qu'elle ne porte pas ;
 *   - « la vue SSH ecrit les cinq lignes » et « la vue SSH refuse un type
 *     inconnu » : NON-REGRESSION, ce chemin etait deja juste, et c'est
 *     l'autre vue qui doit le rejoindre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function windows(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  return pc;
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function parLeTerminal(pc: LinuxPC, ligne: string): Promise<string> {
  const session = new LinuxTerminalSession('term-1', pc);
  session.setInput(ligne);
  session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  await flush();
  await flush();
  return session.lines.map(l => l.text).join('\n');
}

describe('Windows livre les outils que son constructeur compile', () => {
  it('`ssh-keygen` ecrit une paire sous le profil', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\essai');
    expect(out).toContain('Generating public/private ed25519 key pair.');
    expect(out).toContain('Your identification has been saved in C:\\essai');
    expect(out).toContain('Your public key has been saved in C:\\essai.pub');
    expect(out).toContain('The key fingerprint is:');
    expect(out).toContain("The key's randomart image is:");
  });

  it('la publique ecrite par Windows se relit avec `type`', async () => {
    const pc = windows();
    await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\essai');
    const pub = await pc.executeCommand('type C:\\essai.pub');
    expect(pub.trim().startsWith('ssh-ed25519 ')).toBe(true);
  });

  it('Windows refuse un type inconnu comme le fait Linux', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-keygen -t zorglub -N "" -f C:\\z');
    expect(out.toLowerCase()).toContain('unknown key type');
    expect(out).toContain('zorglub');
  });

  it('`ssh-agent -s` rend la forme Bourne', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-agent -s');
    expect(out).toMatch(/SSH_AUTH_SOCK=\S+; export SSH_AUTH_SOCK;/);
    expect(out).toMatch(/echo Agent pid \d+;/);
  });

  it('`ssh-agent -c` rend la forme csh', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-agent -c');
    expect(out).toMatch(/setenv SSH_AUTH_SOCK \S+;/);
  });

  it('`ssh-add -l` sur un agent vide rend la phrase d OpenSSH', async () => {
    const pc = windows();
    expect(await pc.executeCommand('ssh-add -l')).toContain('The agent has no identities.');
  });

  it('`ssh-add <cle>` puis `-l` rend « bits empreinte commentaire (TYPE) »', async () => {
    const pc = windows();
    await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\essai');
    const ajout = await pc.executeCommand('ssh-add C:\\essai');
    expect(ajout).toContain('Identity added: C:\\essai');
    const ligne = (await pc.executeCommand('ssh-add -l')).trim();
    expect(ligne).toMatch(/^256 SHA256:\S+ .+ \(ED25519\)$/m);
  });

  it('`ssh-keyscan` sans hote rend sa ligne d usage', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-keyscan');
    expect(out).toContain('usage: ssh-keyscan');
  });

  it('l agent est celui de la MACHINE : cmd le remplit, PowerShell le voit', async () => {
    const pc = windows();
    await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\essai');
    await pc.executeCommand('ssh-add C:\\essai');
    const parCmd = (await pc.executeCommand('ssh-add -l')).trim();
    const parPowerShell = (await pc.executeCommand('powershell -c "ssh-add -l"')).trim();
    expect(parCmd).toMatch(/^256 SHA256:\S+ .+ \(ED25519\)$/m);
    expect(parPowerShell).toContain(parCmd.split(' ')[1]);
  });

  it('`ssh-copy-id` reste absent, le constructeur ne le compile pas', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-copy-id alice@10.0.0.2');
    expect(out).toContain('is not recognized as an internal or external command');
  });
});

describe('une machine n a qu un ssh-keygen : les deux vues concordent', () => {
  it('la vue SSH ecrit les cinq lignes', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const out = await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f /root/.ssh/vue');
    expect(out).toContain('Generating public/private ed25519 key pair.');
    expect(out).toContain("The key's randomart image is:");
  });

  it('la vue SSH refuse un type inconnu', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const out = await pc.executeCommand('ssh-keygen -t zorglub -N "" -f /root/.ssh/z');
    expect(out.toLowerCase()).toContain('unknown key type');
  });

  it('la vue terminal ecrit le type DEMANDE, pas un autre', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    await parLeTerminal(pc, 'ssh-keygen -t ecdsa -N "" -f /root/.ssh/ec');
    const pub = await pc.executeCommand('cat /root/.ssh/ec.pub');
    expect(pub.trim().startsWith('ecdsa-sha2-nistp256 ')).toBe(true);
  });

  it('la vue terminal refuse le type que la vue SSH refuse', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const out = await parLeTerminal(pc, 'ssh-keygen -t zorglub -N "" -f /root/.ssh/z');
    expect(out.toLowerCase()).toContain('unknown key type');
  });

  it('la privee ecrite par la vue terminal porte de quoi retrouver sa publique', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    await parLeTerminal(pc, 'ssh-keygen -t ed25519 -N "" -f /root/.ssh/vt');
    const surDisque = (await pc.executeCommand('cat /root/.ssh/vt.pub')).trim();
    const deduite = (await pc.executeCommand('ssh-keygen -y -f /root/.ssh/vt')).trim();
    expect(deduite.split(' ')[1]).toBe(surDisque.split(' ')[1]);
  });
});
