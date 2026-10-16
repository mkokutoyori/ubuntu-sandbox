/**
 * Laboratoire SSH_TP_LAN : `ssh-copy-id`. L'outil est un script shell de la distribution
 * OpenSSH pour Unix : il existe sur les postes Linux seulement. Win32-OpenSSH ne le livre
 * pas (son manifeste de paquet ne le liste pas), donc un poste Windows ne l'a pas
 * comme client ; comme cible, un serveur Windows dont le shell par defaut est cmd.exe
 * ne peut pas executer la commande `exec sh -c ...` que le script envoie.
 *
 * Attentes : ssh-copy-id (8.9p1) pour les messages (`INFO: Source of key(s) to be
 * installed`, `Number of key(s) added`, `All keys were skipped because they already
 * exist on the remote system`, `ERROR: No identities found`), et les droits
 * poses sur ~/.ssh et authorized_keys.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const sudo = (host: string, command: string): Promise<string> => lan.run(host, `sudo ${command}`, 'user\n');
const copyId = (client: string, user: string, server: string, extra = ''): Promise<string> =>
  lan.run(client, `sshpass -p ${user} ssh-copy-id ${NOCHECK} ${extra} ${user}@${lan.ip(server)}`.replace(/ {2,}/g, ' '));
const KEY_ONLY = '-o PreferredAuthentications=publickey -o PasswordAuthentication=no -o BatchMode=yes';

describe('ssh-copy-id: what it needs', () => {
  it('fails with no key to install', async () => {
    await lan.run('PC5', 'rm -f /home/user/.ssh/id_*');
    const out = await copyId('PC5', 'alice', 'PC6');
    expect(out).toContain('ERROR: No identities found');
  });

  it('prints its usage with no destination', async () => {
    const out = await lan.run('PC2', 'ssh-copy-id');
    expect(out).toContain('Usage: /usr/bin/ssh-copy-id [-h|-?|-f|-n|-s] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [[-o <ssh -o options>] ...] [user@]hostname');
  });

  it('is absent from a Windows client', async () => {
    const out = await lan.run('PC11', 'ssh-copy-id alice@192.168.10.3');
    expect(out).toContain("'ssh-copy-id' is not recognized as an internal or external command");
  });

  it('is not in the folder of OpenSSH tools Windows ships', async () => {
    expect(await lan.run('PC11', 'dir /b C:\\Windows\\System32\\OpenSSH')).not.toContain('ssh-copy-id');
  });
});

describe('ssh-copy-id: Linux client into a Linux server, across the routers', () => {
  it('installs the default public key and says how many it added', async () => {
    await lan.run('PC2', 'rm -f /home/user/.ssh/id_ed25519*');
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /home/user/.ssh/id_ed25519');
    const out = await copyId('PC2', 'alice', 'PC6');
    expect(out).toContain('/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "/home/user/.ssh/id_ed25519.pub"');
    expect(out).toContain('/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed');
    expect(out).toContain('/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys');
    expect(out).toContain('Number of key(s) added: 1');
    expect(out).toContain(`Now try logging into the machine, with:   "ssh -o 'StrictHostKeyChecking=no' 'alice@${lan.ip('PC6')}'"`);
    expect(out).toContain('and check to make sure that only the key(s) you wanted were added.');
  });

  it('the key then opens the account without any password', async () => {
    const out = await lan.run('PC2', `ssh ${NOCHECK} ${KEY_ONLY} alice@${lan.ip('PC6')} whoami`);
    expect(out.trim()).toBe('alice');
  });

  it('creates the folder and the file with the rights sshd requires, owned by the account', async () => {
    const out = await lan.run('PC6', 'stat -c "%a %U:%G %n" /home/alice/.ssh /home/alice/.ssh/authorized_keys');
    expect(out).toContain('700 alice:alice /home/alice/.ssh');
    expect(out).toContain('600 alice:alice /home/alice/.ssh/authorized_keys');
  });

  it('appends exactly the public key, one line, with its comment', async () => {
    const pub = (await lan.run('PC2', 'cat /home/user/.ssh/id_ed25519.pub')).trim();
    const stored = (await sudo('PC6', 'cat /home/alice/.ssh/authorized_keys')).trim().split('\n');
    expect(stored).toContain(pub);
    expect(stored.filter((line) => line === pub)).toHaveLength(1);
  });

  it('a second run installs nothing and says why', async () => {
    const out = await copyId('PC2', 'alice', 'PC6');
    expect(out).toContain('WARNING: All keys were skipped because they already exist on the remote system.');
    expect(out).toContain('(if you think this is a mistake, you may want to use -f option)');
    expect(out).not.toContain('Number of key(s) added');
    expect((await sudo('PC6', 'cat /home/alice/.ssh/authorized_keys')).trim().split('\n')).toHaveLength(1);
  });

  it('-f installs again even though the key is already there', async () => {
    const out = await copyId('PC2', 'alice', 'PC6', '-f');
    expect(out).toContain('Number of key(s) added: 1');
    expect((await sudo('PC6', 'cat /home/alice/.ssh/authorized_keys')).trim().split('\n')).toHaveLength(2);
  });

  it('-n only shows what would be installed and touches nothing', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /tmp/dry-key');
    const out = await copyId('PC2', 'bob', 'PC6', '-n -i /tmp/dry-key.pub');
    expect(out).toContain('=-=-=-=-=-=-=-=');
    expect(out).toContain('Would have added the following key(s):');
    expect(out).toContain((await lan.run('PC2', 'cat /tmp/dry-key.pub')).trim().split(' ')[1]);
    expect(await sudo('PC6', 'ls /home/bob/.ssh/authorized_keys')).toContain('No such file');
  });

  it('-i names the key to install, and only that key goes over', async () => {
    const out = await copyId('PC2', 'bob', 'PC6', '-i /tmp/dry-key.pub');
    expect(out).toContain('Source of key(s) to be installed: "/tmp/dry-key.pub"');
    expect(out).toContain('Number of key(s) added: 1');
    const keyOnly = await lan.run('PC2', `ssh ${NOCHECK} ${KEY_ONLY} -i /tmp/dry-key bob@${lan.ip('PC6')} whoami`);
    expect(keyOnly.trim()).toBe('bob');
  });

  it('-i with a private key name installs the matching .pub', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /tmp/by-private');
    const out = await copyId('PC2', 'dave', 'PC6', '-i /tmp/by-private');
    expect(out).toContain('Source of key(s) to be installed: "/tmp/by-private.pub"');
    expect(out).toContain('Number of key(s) added: 1');
  });

  it('-p reaches an sshd on another port', async () => {
    await sudo('PC8', '/usr/sbin/sshd -p 2200');
    const out = await copyId('PC2', 'bob', 'PC8', '-p 2200');
    expect(out).toContain('Number of key(s) added: 1');
    expect(out).toContain("-p '2200'");
    await sudo('PC8', 'pkill -f "sshd -p 2200"');
  });

  it('works for a standard user, who owns no administrative right', async () => {
    await lan.run('PC9', 'rm -f /home/user/.ssh/id_ed25519*');
    await lan.run('PC9', 'ssh-keygen -q -t ed25519 -N "" -f /home/user/.ssh/id_ed25519');
    const out = await copyId('PC9', 'bob', 'Server1');
    expect(out).toContain('Number of key(s) added: 1');
    expect(await sudo('Server1', 'stat -c "%U:%a" /home/bob/.ssh/authorized_keys')).toContain('bob:600');
  });

  it('a wrong password installs nothing', async () => {
    const out = await lan.run('PC2', `sshpass -p nope ssh-copy-id ${NOCHECK} -i /tmp/by-private carl@${lan.ip('PC6')}`);
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('Number of key(s) added');
  });

  it('carl, whose shell is nologin, cannot receive a key: the installer cannot run', async () => {
    const out = await copyId('PC2', 'carl', 'PC6');
    expect(out).toContain('This account is currently not available.');
    expect(out).not.toContain('Number of key(s) added');
    expect(await sudo('PC6', 'ls /home/carl/.ssh')).toContain('No such file');
  });

  it('every key of the agent can be installed with -i and no argument', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /tmp/agent-copy');
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add /tmp/agent-copy; sshpass -p dave ssh-copy-id ${NOCHECK} -f dave@${lan.ip('Server1')}`);
    expect(out).toContain('Number of key(s) added:');
  });

  it('the server journal shows the password login then the key login', async () => {
    const journal = await sudo('PC6', 'grep "Accepted" /var/log/auth.log');
    expect(journal).toMatch(/Accepted password for alice from 192\.168\.30\.5/);
    expect(journal).toMatch(/Accepted publickey for alice from 192\.168\.30\.5/);
  });
});

describe('ssh-copy-id: Linux client towards a Windows server', () => {
  it('reaches the account but cannot run the Unix installer in cmd.exe', async () => {
    await lan.run('PC2', 'rm -f /home/user/.ssh/id_ed25519*');
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /home/user/.ssh/id_ed25519');
    const out = await copyId('PC2', 'bob', 'PC1');
    expect(out).toContain("'exec' is not recognized as an internal or external command");
    expect(out).not.toContain('Number of key(s) added');
  });

  it('so no key was installed for the account', async () => {
    expect(await lan.run('PC1', 'dir C:\\Users\\bob\\.ssh')).toMatch(/File Not Found|cannot find/);
    const out = await lan.run('PC2', `ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC1')} hostname`);
    expect(out).toContain('Permission denied');
  });

  it('the account still answers to its password, so the failure is the installer alone', async () => {
    const out = await lan.withPassword('PC2', `ssh ${NOCHECK} bob@${lan.ip('PC1')} hostname`, 'bob');
    expect(out.trim()).toBe('PC1');
  });

  it('the manual way works: the key is appended to the right file for the profile', async () => {
    const pub = (await lan.run('PC2', 'cat /home/user/.ssh/id_ed25519.pub')).trim();
    await lan.asWindowsAdministrator('PC1', ['mkdir C:\\Users\\bob\\.ssh', `echo ${pub}>> C:\\Users\\bob\\.ssh\\authorized_keys`]);
    const out = await lan.run('PC2', `ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC1')} hostname`);
    expect(out.trim()).toBe('PC1');
  });
});
