/*
 * `ssh-keygen` genere comme OpenSSH 8.9p1 : type par defaut, longueurs
 * admises, repertoire cree, ligne d'empreinte.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `ssh-keygen.c` : construit avec OpenSSL, le type par
 *   defaut est « rsa » (`DEFAULT_KEY_TYPE_NAME`), sur 3072 bits
 *   (`DEFAULT_BITS`) ; Win32-OpenSSH 8.6p1, construit avec LibreSSL, porte
 *   la meme definition. `type_bits_valid` refuse, AVANT d'annoncer la
 *   generation, une cle RSA de moins de 1024 bits (« Invalid RSA key
 *   length: minimum is 1024 bits ») ou de plus de 16384 (« … maximum is
 *   16384 bits ») et une longueur ECDSA autre que 256, 384 ou 521 ; une
 *   longueur donnee a Ed25519 est ignoree. `fatal` sort en 255. La
 *   generation ecrit « Generating public/private <type> key pair. » PUIS
 *   demande le fichier (« Enter file in which to save the key (<home>/.ssh/
 *   id_rsa): »). Apres « The key fingerprint is: », la ligne est « %s %s »,
 *   l'empreinte puis le commentaire. L'echec d'ecriture s'ecrit « Saving
 *   key "<fichier>" failed: <raison> » et sort en 1, la raison etant celle
 *   d'open(2) : EACCES sous un repertoire que l'utilisateur ne peut pas
 *   traverser (/root, 0700), ENOENT sous un repertoire absent ;
 * - `hostfile.c` (`hostfile_create_user_ssh_dir`) : seul ~/.ssh est cree,
 *   en 0700, et, hors `-q`, « Created directory '<home>/.ssh'. » l'annonce ;
 *   un autre repertoire manquant n'est pas cree ;
 * - `log.c` : sur la sortie d'erreur, `error` et `fatal` n'ont ni prefixe
 *   ni nom de programme ;
 * - `openbsd-compat/getopt_long.c` : sans `optreset` dans la libc, OpenSSH
 *   compile son propre getopt, qui ne permute pas et ecrit « unknown option
 *   -- x » ou « option requires an argument -- x » ; `ssh-keygen` ajoute
 *   son usage et sort en 1, `ssh` ajoute le sien et sort en 255. `ssh -1`
 *   est fatal : « SSH protocol v.1 is no longer supported » ;
 * - `ssh-keygen.c` : `-b` passe par `strtonum` (« Bits has bad value <v>
 *   (invalid) »), `-E` par `ssh_digest_alg_by_name` (« Invalid hash
 *   algorithm "<v>" ») ; `-l` ecrit « no comment » pour une cle sans
 *   commentaire ; deux phrases differentes font ecrire « Passphrases do
 *   not match.  Try again. » et redemander ; les reponses se lisent sur
 *   l'entree standard, et une entree vide a la question du fichier fait
 *   sortir en 1.
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire l'implantation.
 * 22 des 25 cas tombent avant le correctif. Passent des deux cotes le
 * TEMOIN du cadre RSA 3072, qui prouve que le laboratoire genere, le
 * TEMOIN d'Ed25519 qui ignore `-b`, et `-q` qui cree ~/.ssh en silence :
 * l'ancien code creait deja le repertoire, sans rien dire, quel qu'il
 * soit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

function linux(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  return pc;
}

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const typedInto = async (term: LinuxTerminalSession, text: string): Promise<void> => {
  if (term.currentInputMode.type === 'password') term.setPasswordBuf(text);
  else term.setInput(text);
  term.handleKey(key('Enter'));
  await settle();
};

const promptOf = (term: LinuxTerminalSession): string | undefined =>
  (term.currentInputMode as { promptText?: string }).promptText;

const FINGERPRINT_LINE = /^SHA256:[A-Za-z0-9+/]{43} probe@lab$/;

describe('the default key', () => {
  it('without -t, the key is RSA 3072', async () => {
    const pc = linux();
    await pc.executeCommand("ssh-keygen -q -N '' -f ~/.ssh/k");

    expect((await pc.executeCommand('cut -d" " -f1 ~/.ssh/k.pub')).trim()).toBe('ssh-rsa');
    expect(await pc.executeCommand('ssh-keygen -l -f ~/.ssh/k.pub')).toMatch(/^3072 SHA256:/);
  }, 60_000);

  it('the terminal announces the RSA pair, then offers ~/.ssh/id_rsa', async () => {
    const term = new LinuxTerminalSession('t1', linux());
    const before = term.lines.length;
    term.setInput('ssh-keygen');
    term.handleKey(key('Enter'));
    await settle();

    const shown = term.lines.slice(before + 1).map((l) => l.text).filter((t) => t.trim() !== '');
    expect(shown[0]).toBe('Generating public/private rsa key pair.');
    expect((term.currentInputMode as { promptText?: string }).promptText)
      .toBe('Enter file in which to save the key (/home/user/.ssh/id_rsa): ');
  }, 60_000);

  it('Windows: without -t, the key is RSA too', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    pc.powerOn();
    await pc.executeCommand('ssh-keygen -q -N "" -f C:\\k');

    expect((await pc.executeCommand('type C:\\k.pub')).trim().startsWith('ssh-rsa ')).toBe(true);
  }, 60_000);
});

describe('the generation transcript', () => {
  it('the fingerprint line is the fingerprint and the comment, nothing else', async () => {
    const out = await linux().executeCommand("ssh-keygen -t ed25519 -N '' -C probe@lab -f /tmp/k");
    const lines = out.split('\n');

    expect(lines[lines.indexOf('The key fingerprint is:') + 1]).toMatch(FINGERPRINT_LINE);
  });

  it('the randomart frames an RSA 3072 key — WITNESS', async () => {
    const out = await linux().executeCommand("ssh-keygen -t rsa -N '' -f /tmp/k");

    expect(out).toContain('+---[RSA 3072]----+');
    expect(out).toContain('+----[SHA256]-----+');
  }, 60_000);
});

describe('the directory', () => {
  it('a missing ~/.ssh is created 0700 and announced', async () => {
    const pc = linux();
    await pc.executeCommand('rm -rf ~/.ssh');
    const out = await pc.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519");

    expect(out.split('\n').slice(0, 3)).toEqual([
      'Generating public/private ed25519 key pair.',
      "Created directory '/home/user/.ssh'.",
      'Your identification has been saved in /home/user/.ssh/id_ed25519',
    ]);
    expect((await pc.executeCommand('stat -c %a ~/.ssh')).trim()).toBe('700');
  });

  it('-q creates it silently', async () => {
    const pc = linux();
    await pc.executeCommand('rm -rf ~/.ssh');

    expect(await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519")).toBe('');
    expect((await pc.executeCommand('stat -c %a ~/.ssh')).trim()).toBe('700');
  });

  it('another missing directory is not created: saving fails', async () => {
    const pc = linux();
    const out = await pc.executeCommand("ssh-keygen -t ed25519 -N '' -f /tmp/nodir/k; echo rc=$?");

    expect(out).toContain('Saving key "/tmp/nodir/k" failed: No such file or directory');
    expect(out).toContain('rc=1');
    expect(await pc.executeCommand('ls -d /tmp/nodir 2>&1')).toContain('No such file or directory');
  });
});

describe('the rights', () => {
  it('a directory the user cannot search refuses the save', async () => {
    const pc = linux();
    const out = await pc.executeCommand("ssh-keygen -t ed25519 -N '' -f /root/.ssh/k; echo rc=$?");

    expect(out).toContain('Saving key "/root/.ssh/k" failed: Permission denied');
    expect(out).toContain('rc=1');
    expect(await pc.executeCommand('sudo ls /root/.ssh/k 2>&1')).toContain('No such file or directory');
  });
});

describe('the key length', () => {
  it('RSA under 1024 bits is refused before anything is announced', async () => {
    const pc = linux();
    const out = await pc.executeCommand("ssh-keygen -t rsa -b 512 -N '' -f /tmp/k; echo rc=$?");

    expect(out.trim()).toBe('Invalid RSA key length: minimum is 1024 bits\nrc=255');
    expect(await pc.executeCommand('ls /tmp/k 2>&1')).toContain('No such file or directory');
  });

  it('RSA over 16384 bits is refused', async () => {
    const out = await linux().executeCommand("ssh-keygen -t rsa -b 20000 -N '' -f /tmp/k; echo rc=$?");

    expect(out.trim()).toBe('Invalid RSA key length: maximum is 16384 bits\nrc=255');
  });

  it('an ECDSA length off the three curves is refused', async () => {
    const out = await linux().executeCommand("ssh-keygen -t ecdsa -b 128 -N '' -f /tmp/k; echo rc=$?");

    expect(out.trim()).toBe('Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits\nrc=255');
  });

  it('a length given to Ed25519 is ignored — WITNESS', async () => {
    const pc = linux();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -b 1024 -N '' -f /tmp/k");

    expect(await pc.executeCommand('ssh-keygen -l -f /tmp/k.pub')).toMatch(/^256 SHA256:.*\(ED25519\)$/m);
  });
});

describe('the command line', () => {
  it('an unknown ssh-keygen option is named the BSD way, then the usage', async () => {
    const out = await linux().executeCommand('ssh-keygen -j; echo rc=$?');

    expect(out.split('\n')[0]).toBe('unknown option -- j');
    expect(out).toContain('usage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]');
    expect(out).toContain('rc=1');
  });

  it('an unknown ssh option is named the same way, then the ssh usage', async () => {
    const out = await linux().executeCommand('ssh -Z alice@10.9.9.9; echo rc=$?');

    expect(out.split('\n').slice(0, 2)).toEqual([
      'unknown option -- Z',
      'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
    ]);
    expect(out).toContain('rc=255');
  });

  it('ssh -1 is fatal', async () => {
    expect((await linux().executeCommand('ssh -1 alice@10.9.9.9')).trim())
      .toBe('SSH protocol v.1 is no longer supported');
  });

  it('a non-numeric -b is refused by strtonum', async () => {
    expect((await linux().executeCommand("ssh-keygen -b abc -N '' -f /tmp/k")).trim())
      .toBe('Bits has bad value abc (invalid)');
  });

  it('an unknown -E hash is refused', async () => {
    expect((await linux().executeCommand('ssh-keygen -l -E foo -f /tmp/k')).trim())
      .toBe('Invalid hash algorithm "foo"');
  });

  it('-E sha512 fingerprints with SHA512', async () => {
    const pc = linux();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C probe@lab -f /tmp/k");

    expect(await pc.executeCommand('ssh-keygen -l -E sha512 -f /tmp/k.pub'))
      .toMatch(/^256 SHA512:[A-Za-z0-9+/]{86} probe@lab \(ED25519\)$/m);
  });

  it('grouped letters are read by getopt: -lf fingerprints, it does not generate', async () => {
    const pc = linux();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C probe@lab -f /tmp/k");

    expect(await pc.executeCommand('ssh-keygen -lf /tmp/k.pub'))
      .toMatch(/^256 SHA256:\S+ probe@lab \(ED25519\)$/);
    expect(await pc.executeCommand('ls ~/.ssh/id_ed25519 ~/.ssh/id_rsa 2>&1')).not.toMatch(/^\/home/m);
  });

  it('a key without comment is fingerprinted with « no comment »', async () => {
    const pc = linux();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C '' -f /tmp/k");

    expect(await pc.executeCommand('ssh-keygen -l -f /tmp/k.pub'))
      .toMatch(/^256 SHA256:\S+ no comment \(ED25519\)$/m);
  });
});

describe('the answers', () => {
  it('the file is read from standard input', async () => {
    const pc = linux();
    await pc.executeCommand("echo /tmp/viapipe | ssh-keygen -q -t ed25519 -N ''");

    expect((await pc.executeCommand('cut -d" " -f1 /tmp/viapipe.pub')).trim()).toBe('ssh-ed25519');
  });

  it('an empty standard input ends ssh-keygen at the file question', async () => {
    const pc = linux();
    const out = await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' < /dev/null; echo rc=$?");

    expect(out).toContain('rc=1');
    expect(await pc.executeCommand('ls ~/.ssh/id_ed25519 2>&1')).toContain('No such file or directory');
  });

  it('the terminal asks again when the two passphrases differ', async () => {
    const term = new LinuxTerminalSession('t2', linux());
    await typedInto(term, 'ssh-keygen -t ed25519 -f /tmp/k');
    expect(promptOf(term)).toBe('Enter passphrase (empty for no passphrase): ');
    await typedInto(term, 'one');
    await typedInto(term, 'two');

    expect(term.lines.map((l) => l.text)).toContain('Passphrases do not match.  Try again.');
    expect(promptOf(term)).toBe('Enter passphrase (empty for no passphrase): ');
  });

  it('a passphrase the simulator cannot apply is refused rather than dropped', async () => {
    const pc = linux();
    const out = await pc.executeCommand("ssh-keygen -t ed25519 -N secret -f /tmp/k; echo rc=$?");

    expect(out).toContain('rc=255');
    expect(await pc.executeCommand('ls /tmp/k 2>&1')).toContain('No such file or directory');
  });
});
