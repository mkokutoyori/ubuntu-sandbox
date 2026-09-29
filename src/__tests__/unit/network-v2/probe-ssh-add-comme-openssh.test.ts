/*
 * `ssh-add` repond comme OpenSSH 8.9p1 (Ubuntu 22.04) et 8.6p1 (Windows).
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `ssh-add.c` :
 *   - sans fichier, les identites par defaut sont « %s/%s », le repertoire
 *     de l'utilisateur puis `.ssh/id_rsa`, `.ssh/id_ecdsa`, …,
 *     `.ssh/id_ed25519`, …, `.ssh/id_dsa`, dans cet ordre ; celles qui
 *     n'existent pas sont passees, et si aucune n'est chargee la commande
 *     sort en 1 sans rien ecrire ;
 *   - `add_file` : un fichier absent s'ecrit comme `perror` (« <f>: No
 *     such file or directory ») ; un fichier qui n'est pas une cle
 *     « Error loading key "<f>": invalid format » ; une cle privee lisible
 *     par d'autres est refusee par `sshkey_perm_ok` (« WARNING: UNPROTECTED
 *     PRIVATE KEY FILE! », « Permissions 0644 for '<f>' are too open. ») ;
 *     sinon « Identity added: <f> (<commentaire>) » ;
 *   - `delete_one` : « Identity removed: <f> <TYPE> (<commentaire>) » ; une
 *     cle que l'agent ne porte pas : « Could not remove identity "<f>":
 *     agent refused operation » ;
 *   - `delete_all` : « All identities removed. », tu par `-q` ;
 *   - l'agent range ses identites par cle, pas par chemin ;
 *   - le getopt de `openbsd-compat` ecrit « unknown option -- x », puis
 *     l'usage, sortie 1 ; `-l` puis `-L` : « -l flag already specified »,
 *     le drapeau deja vu ; `-E` choisit le condense de `-l` ;
 * - Win32-OpenSSH 8.6p1 (`contrib/win32/win32compat`) : sans
 *   SSH_AUTH_SOCK, le client vise le tube `\\.\pipe\openssh-ssh-agent` ;
 *   tube absent, `ERROR_FILE_NOT_FOUND` devient ENOENT : « Error connecting
 *   to agent: No such file or directory », sortie 2 ;
 * - Microsoft, « Key-based authentication in OpenSSH for Windows » : « By
 *   default, the ssh-agent service is disabled », et on le met en route,
 *   depuis une invite elevee, par `Set-Service -StartupType` puis
 *   `Start-Service ssh-agent`.
 *
 * Ecrite a l'aveugle contre ces sources, avant de reecrire la commande.
 * 14 des 16 cas tombent avant le correctif. Passent des deux cotes le
 * TEMOIN de la liste (« 256 SHA256:… commentaire (ED25519) »), qui prouve
 * que l'agent du laboratoire charge une cle, et l'ordre id_rsa puis
 * id_ed25519, que la liste partagee des identites par defaut donnait deja.
 * Relu contre la source apres coup : `-l` puis `-L` fait nommer `-l`, le
 * drapeau deja vu, et non `-L` comme la premiere ecriture le supposait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

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

function windows(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  return pc;
}

const keygen = (pc: LinuxPC, type: string, file: string, comment = 'probe@lab') =>
  pc.executeCommand(`ssh-keygen -q -t ${type} -N '' -C ${comment} -f ${file}`);

describe('the default identities', () => {
  it('no default identity on disk: nothing is written, exit 1', async () => {
    expect(await linux().executeCommand('ssh-add; echo rc=$?')).toBe('rc=1');
  });

  it('the defaults are loaded id_rsa first, then id_ed25519', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '~/.ssh/id_ed25519', 'ed@lab');
    await keygen(pc, 'rsa -b 1024', '~/.ssh/id_rsa', 'rsa@lab');

    expect((await pc.executeCommand('ssh-add')).split('\n')).toEqual([
      'Identity added: /home/user/.ssh/id_rsa (rsa@lab)',
      'Identity added: /home/user/.ssh/id_ed25519 (ed@lab)',
    ]);
  }, 60_000);

  it('-d without a file removes the defaults, naming type and comment', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '~/.ssh/id_ed25519', 'ed@lab');
    await pc.executeCommand('ssh-add');

    expect((await pc.executeCommand('ssh-add -d')).trim())
      .toBe('Identity removed: /home/user/.ssh/id_ed25519 ED25519 (ed@lab)');
  });
});

describe('what ssh-add refuses to load', () => {
  it('a missing file is named the way perror does', async () => {
    expect(await linux().executeCommand('ssh-add /nope; echo rc=$?'))
      .toBe('/nope: No such file or directory\nrc=1');
  });

  it('a file that is not a key is refused', async () => {
    const pc = linux();
    const out = await pc.executeCommand('ssh-add /etc/hostname; echo rc=$?');

    expect(out).toBe('Error loading key "/etc/hostname": invalid format\nrc=1');
    expect(await pc.executeCommand('ssh-add -l')).toContain('The agent has no identities.');
  });

  it('a private key readable by others is ignored', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '/tmp/k');
    await pc.executeCommand('chmod 644 /tmp/k');
    const out = await pc.executeCommand('ssh-add /tmp/k; echo rc=$?');

    expect(out).toContain('@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @');
    expect(out).toContain("Permissions 0644 for '/tmp/k' are too open.");
    expect(out).toContain('rc=1');
    expect(await pc.executeCommand('ssh-add -l')).toContain('The agent has no identities.');
  });
});

describe('the agent holds keys, not paths', () => {
  it('the same key from two paths is one identity', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '/tmp/k');
    await pc.executeCommand('cp /tmp/k /tmp/copy');
    await pc.executeCommand('chmod 600 /tmp/copy');
    await pc.executeCommand('ssh-add /tmp/k');
    await pc.executeCommand('ssh-add /tmp/copy');

    expect((await pc.executeCommand('ssh-add -l')).trim().split('\n')).toHaveLength(1);
  });

  it('removing a key the agent does not hold is refused', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '/tmp/k');

    expect(await pc.executeCommand('ssh-add -d /tmp/k; echo rc=$?'))
      .toBe('Could not remove identity "/tmp/k": agent refused operation\nrc=1');
  });

  it('a loaded key is listed with bits, fingerprint, comment and type — WITNESS', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '/tmp/k');
    await pc.executeCommand('ssh-add /tmp/k');

    expect((await pc.executeCommand('ssh-add -l')).trim()).toMatch(/^256 SHA256:\S+ probe@lab \(ED25519\)$/);
  });
});

describe('the command line', () => {
  it('-D -q removes silently', async () => {
    expect(await linux().executeCommand('ssh-add -D -q; echo rc=$?')).toBe('rc=0');
  });

  it('an unknown option is named, then the usage', async () => {
    const out = await linux().executeCommand('ssh-add -Z; echo rc=$?');

    expect(out.split('\n').slice(0, 2)).toEqual([
      'unknown option -- Z',
      'usage: ssh-add [-cDdKkLlqvXx] [-E fingerprint_hash] [-H hostkey_file]',
    ]);
    expect(out).toContain('rc=1');
  });

  it('-l and -L together are one listing too many', async () => {
    expect((await linux().executeCommand('ssh-add -l -L')).trim()).toBe('-l flag already specified');
  });

  it('-E md5 lists the MD5 fingerprint', async () => {
    const pc = linux();
    await keygen(pc, 'ed25519', '/tmp/k');
    await pc.executeCommand('ssh-add /tmp/k');

    expect((await pc.executeCommand('ssh-add -E md5 -l')).trim()).toMatch(/^256 MD5:([0-9a-f]{2}:){15}[0-9a-f]{2} probe@lab \(ED25519\)$/);
  });
});

describe('Windows: the agent is a service, disabled out of the box', () => {
  it('ssh-add cannot reach the agent pipe', async () => {
    expect((await windows().executeCommand('ssh-add -l')).trim())
      .toBe('Error connecting to agent: No such file or directory');
  });

  it('the service exists, disabled', async () => {
    const out = await windows().executeCommand('sc qc ssh-agent');

    expect(out).toContain('START_TYPE         : 4   DISABLED');
    expect(out).toContain('OpenSSH Authentication Agent');
  });

  it('once an administrator starts it, the agent loads the profile identities, joined with a slash', async () => {
    const pc = windows();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('ssh-keygen -q -t ed25519 -N "" -C win@lab');
    await pc.executeCommand('sc config ssh-agent start= demand');
    await pc.executeCommand('net start ssh-agent');

    expect((await pc.executeCommand('ssh-add')).trim())
      .toBe('Identity added: C:\\Users\\Administrator/.ssh/id_ed25519 (win@lab)');
  });
});
