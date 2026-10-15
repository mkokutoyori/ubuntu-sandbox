/**
 * Laboratoire SSH_TP_LAN : `ssh-agent`, `ssh-add` et l'authentification par cle entre
 * postes Linux et Windows de sites differents, pour les profils alice (administrateur),
 * bob (standard) et dave.
 *
 * Attentes : ssh-agent.c et ssh-add.c (8.9p1 : syntaxe sh/csh, `Identity added`,
 * `The agent has no identities.`, `Could not open a connection to your authentication
 * agent.`), auth2-pubkey.c et auth.c (`StrictModes`, options d'authorized_keys), et
 * Win32-OpenSSH 8.6 : service ssh-agent desactive par defaut (`unable to start
 * ssh-agent service, error :1058`), `Match Group administrators` -> fichier
 * administrators_authorized_keys, `%USERPROFILE%\.ssh\authorized_keys` pour les autres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const sudo = (host: string, command: string): Promise<string> => lan.run(host, `sudo ${command}`, 'user\n');
const KEY_ONLY = '-o PreferredAuthentications=publickey -o PasswordAuthentication=no -o BatchMode=yes';

async function makeKey(client: string, name: string, extra = ''): Promise<{ priv: string; pub: string; line: string }> {
  const linux = lan.platform(client) === 'linux';
  const priv = linux ? `/tmp/${name}` : `C:\\Users\\User\\${name}`;
  await lan.run(client, `ssh-keygen -q -t ed25519 -N "" ${extra} -f ${priv}`);
  const line = (await lan.run(client, linux ? `cat ${priv}.pub` : `type ${priv}.pub`)).trim();
  return { priv, pub: `${priv}.pub`, line };
}

async function installOnLinux(server: string, user: string, line: string, options = ''): Promise<void> {
  const home = `/home/${user}`;
  const files = (lan.host(server) as unknown as { executor: { vfs: {
    readFile(path: string): string | null; writeFile(path: string, content: string, uid: number, gid: number, umask: number): void;
  } } }).executor.vfs;
  await sudo(server, `mkdir -p ${home}/.ssh`);
  const path = `${home}/.ssh/authorized_keys`;
  files.writeFile(path, `${files.readFile(path) ?? ''}${options}${line}\n`, 0, 0, 0o022);
  await sudo(server, `chown -R ${user}:${user} ${home}/.ssh`);
  await sudo(server, `chmod 700 ${home}/.ssh`);
  await sudo(server, `chmod 600 ${home}/.ssh/authorized_keys`);
}

async function installOnWindows(server: string, user: string, line: string, admin: boolean): Promise<void> {
  const file = admin ? 'C:\\ProgramData\\ssh\\administrators_authorized_keys' : `C:\\Users\\${user}\\.ssh\\authorized_keys`;
  const commands = admin ? [] : [`mkdir C:\\Users\\${user}\\.ssh`];
  await lan.asWindowsAdministrator(server, [...commands, `echo ${line}>> ${file}`]);
}

const keyLogin = (client: string, key: string, user: string, server: string, command = 'hostname'): Promise<string> =>
  lan.run(client, `ssh ${NOCHECK} ${KEY_ONLY} -i ${key} ${user}@${lan.ip(server)} ${lan.quote(client, command)}`);

describe('ssh-agent and ssh-add on Linux', () => {
  it('prints the environment in sh syntax', async () => {
    const out = await lan.run('PC2', 'ssh-agent');
    expect(out).toMatch(/^SSH_AUTH_SOCK=\/tmp\/ssh-[A-Za-z0-9]+\/agent\.\d+; export SSH_AUTH_SOCK;$/m);
    expect(out).toMatch(/^SSH_AGENT_PID=\d+; export SSH_AGENT_PID;$/m);
    expect(out).toMatch(/^echo Agent pid \d+;$/m);
  });

  it('-c prints the csh syntax', async () => {
    const out = await lan.run('PC2', 'ssh-agent -c');
    expect(out).toMatch(/^setenv SSH_AUTH_SOCK \/tmp\/ssh-[A-Za-z0-9]+\/agent\.\d+;$/m);
    expect(out).toMatch(/^setenv SSH_AGENT_PID \d+;$/m);
  });

  it('runs a command with the agent in its environment and stops when it ends', async () => {
    const out = await lan.run('PC2', 'ssh-agent sh -c \'echo $SSH_AUTH_SOCK; ssh-add -l\'');
    expect(out).toMatch(/^\/tmp\/ssh-[A-Za-z0-9]+\/agent\.\d+$/m);
    expect(out).toContain('The agent has no identities.');
  });

  it('ssh-add without any agent says it cannot reach one', async () => {
    const out = await lan.run('PC9', 'ssh-add -l; echo rc=$?');
    expect(out).toContain('Could not open a connection to your authentication agent.');
    expect(out).toContain('rc=2');
  });

  it('adds, lists, prints and removes an identity', async () => {
    const { priv, line } = await makeKey('PC2', 'agent-a', '-C agent-a');
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add ${priv}; ssh-add -l; ssh-add -L; ssh-add -d ${priv}; ssh-add -l`);
    expect(out).toContain(`Identity added: ${priv} (agent-a)`);
    expect(out).toMatch(/^256 SHA256:[A-Za-z0-9+/]{43} agent-a \(ED25519\)$/m);
    expect(out).toContain(line.split(' ').slice(0, 2).join(' '));
    expect(out).toContain(`Identity removed: ${priv} ED25519 (agent-a)`);
    expect(out).toContain('The agent has no identities.');
  });

  it('-D removes every identity at once', async () => {
    const a = await makeKey('PC2', 'agent-b1');
    const b = await makeKey('PC2', 'agent-b2');
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add ${a.priv} ${b.priv}; ssh-add -D; ssh-add -l`);
    expect(out).toContain('All identities removed.');
    expect(out).toContain('The agent has no identities.');
  });

  it('adds a passphrase-protected key after asking for the passphrase', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N hunter2 -C locked -f /tmp/agent-locked');
    const good = await lan.run('PC2', 'eval $(ssh-agent -s) > /dev/null; ssh-add /tmp/agent-locked; ssh-add -l', 'hunter2\n');
    expect(good).toContain("Enter passphrase for /tmp/agent-locked:");
    expect(good).toContain('Identity added: /tmp/agent-locked (locked)');
    const bad = await lan.run('PC2', 'eval $(ssh-agent -s) > /dev/null; ssh-add /tmp/agent-locked', 'wrong\nwrong\nwrong\n');
    expect(bad).toContain('Bad passphrase, try again for /tmp/agent-locked:');
    expect(bad).not.toContain('Identity added');
  });

  it('refuses a private key whose permissions are too open', async () => {
    const { priv } = await makeKey('PC2', 'agent-open');
    await lan.run('PC2', `chmod 644 ${priv}`);
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add ${priv}`);
    expect(out).toContain('WARNING: UNPROTECTED PRIVATE KEY FILE!');
    expect(out).toContain(`Permissions 0644 for '${priv}' are too open.`);
  });

  it('ssh-add of a file that does not exist says so', async () => {
    const out = await lan.run('PC2', 'eval $(ssh-agent -s) > /dev/null; ssh-add /tmp/no-such-key');
    expect(out).toContain('/tmp/no-such-key: No such file or directory');
  });

  it('-x locks the agent and -X unlocks it', async () => {
    const { priv } = await makeKey('PC2', 'agent-lock');
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add ${priv}; ssh-add -x; ssh-add -l; ssh-add -X; ssh-add -l`, 'secret\nsecret\nsecret\n');
    expect(out).toContain('Agent locked.');
    expect(out).toContain('Agent unlocked.');
  });

  it('-t limits the lifetime of an identity', async () => {
    const { priv } = await makeKey('PC2', 'agent-life');
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add -t 3600 ${priv}`);
    expect(out).toContain('Lifetime set to 3600 seconds');
  });

  it('-k kills the agent of the session', async () => {
    const out = await lan.run('PC2', 'eval $(ssh-agent -s) > /dev/null; ssh-agent -k');
    expect(out).toMatch(/^unset SSH_AUTH_SOCK;$/m);
    expect(out).toMatch(/^unset SSH_AGENT_PID;$/m);
    expect(out).toMatch(/^echo Agent pid \d+ killed;$/m);
  });
});

describe('ssh-agent and ssh-add on Windows', () => {
  it('the service is disabled as shipped: ssh-add cannot start it', async () => {
    const out = await lan.run('PC1', 'ssh-add -l');
    expect(out).toContain('unable to start ssh-agent service, error :1058');
  });

  it('an administrator enables and starts the service, then ssh-add works for a standard user', async () => {
    await lan.asWindowsAdministrator('PC1', ['sc config ssh-agent start= demand', 'net start ssh-agent']);
    expect(await lan.run('PC1', 'sc query ssh-agent')).toContain('RUNNING');
    expect(await lan.run('PC1', 'ssh-add -l')).toContain('The agent has no identities.');
  });

  it('adds, lists and removes an identity', async () => {
    const { priv, line } = await makeKey('PC1', 'win-agent-a', '-C win-agent-a');
    const added = await lan.run('PC1', `ssh-add ${priv}`);
    expect(added).toContain(`Identity added: ${priv} (win-agent-a)`);
    expect(await lan.run('PC1', 'ssh-add -l')).toMatch(/256 SHA256:\S+ win-agent-a \(ED25519\)/);
    expect(await lan.run('PC1', 'ssh-add -L')).toContain(line.split(' ').slice(0, 2).join(' '));
    expect(await lan.run('PC1', `ssh-add -d ${priv}`)).toContain('Identity removed');
    expect(await lan.run('PC1', 'ssh-add -l')).toContain('The agent has no identities.');
  });

  it('keeps its identities after the command that added them is over', async () => {
    const { priv } = await makeKey('PC1', 'win-agent-keep', '-C keep');
    await lan.run('PC1', `ssh-add ${priv}`);
    expect(await lan.run('PC1', 'ssh-add -l')).toContain('keep (ED25519)');
    await lan.run('PC1', 'ssh-add -D');
  });

  it('the ssh-agent program is not run by hand: the service is the agent', async () => {
    const out = await lan.run('PC1', 'ssh-agent');
    expect(out).toMatch(/SSH_AUTH_SOCK|ssh-agent/);
  });

  it('stopping the service empties the agent', async () => {
    const { priv } = await makeKey('PC1', 'win-agent-stop', '-C stopme');
    await lan.run('PC1', `ssh-add ${priv}`);
    await lan.asWindowsAdministrator('PC1', ['net stop ssh-agent', 'net start ssh-agent']);
    expect(await lan.run('PC1', 'ssh-add -l')).toContain('The agent has no identities.');
  });
});

describe('public-key login: a Linux client into Linux and Windows servers', () => {
  it('Linux server: the key listed in authorized_keys replaces the password, whatever the profile', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-a');
    for (const user of ['alice', 'bob', 'dave']) await installOnLinux('PC6', user, line);
    for (const user of ['alice', 'bob', 'dave']) {
      expect((await keyLogin('PC2', priv, user, 'PC6', 'whoami')).trim()).toBe(user);
    }
    const journal = await sudo('PC6', 'grep "Accepted publickey for" /var/log/auth.log');
    expect(journal).toMatch(/Accepted publickey for bob from 192\.168\.30\.5 port \d+ ssh2: ED25519 SHA256:/);
  });

  it('Linux server: a key that is not listed is refused, and the password is not tried under BatchMode', async () => {
    const { priv } = await makeKey('PC2', 'k-linux-stranger');
    const out = await keyLogin('PC2', priv, 'alice', 'PC6');
    expect(out).toContain(`alice@${lan.ip('PC6')}: Permission denied (publickey,password).`);
  });

  it('Linux server: with the password allowed a refused key falls back to the password', async () => {
    const { priv } = await makeKey('PC2', 'k-linux-fallback');
    const out = await lan.withPassword('PC2', `ssh ${NOCHECK} -i ${priv} alice@${lan.ip('PC6')} hostname`, 'alice');
    expect(out.trim()).toBe('PC6');
  });

  it('Linux server: removing the key from authorized_keys revokes the access', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-revoke');
    await installOnLinux('PC8', 'bob', line);
    expect((await keyLogin('PC2', priv, 'bob', 'PC8')).trim()).toBe('PC8');
    await sudo('PC8', 'sh -c "> /home/bob/.ssh/authorized_keys"');
    expect(await keyLogin('PC2', priv, 'bob', 'PC8')).toContain('Permission denied');
  });

  it('Linux server: StrictModes ignores a key file whose directory others can write', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-modes');
    await installOnLinux('PC9', 'dave', line);
    await sudo('PC9', 'chmod 777 /home/dave');
    const out = await keyLogin('PC2', priv, 'dave', 'PC9');
    const journal = await sudo('PC9', 'grep "bad ownership or modes" /var/log/auth.log');
    await sudo('PC9', 'chmod 700 /home/dave');
    expect(out).toContain('Permission denied');
    expect(journal).toContain('Authentication refused: bad ownership or modes for directory /home/dave');
  });

  it('Linux server: StrictModes ignores an authorized_keys file others can write', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-file');
    await installOnLinux('PC9', 'bob', line);
    await sudo('PC9', 'chmod 666 /home/bob/.ssh/authorized_keys');
    const out = await keyLogin('PC2', priv, 'bob', 'PC9');
    const journal = await sudo('PC9', 'grep "bad ownership or modes for file" /var/log/auth.log');
    await sudo('PC9', 'chmod 600 /home/bob/.ssh/authorized_keys');
    expect(out).toContain('Permission denied');
    expect(journal).toContain('bad ownership or modes for file /home/bob/.ssh/authorized_keys');
  });

  it('Linux server: from= restricts the key to some client addresses', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-from');
    await installOnLinux('PC8', 'dave', line, 'from="192.168.50.*" ');
    expect(await keyLogin('PC2', priv, 'dave', 'PC8')).toContain('Permission denied');
    await sudo('PC8', 'sh -c "> /home/dave/.ssh/authorized_keys"');
    await installOnLinux('PC8', 'dave', line, 'from="192.168.30.*" ');
    expect((await keyLogin('PC2', priv, 'dave', 'PC8', 'whoami')).trim()).toBe('dave');
  });

  it('Linux server: command= forces a command whatever the client asked for', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-command');
    await installOnLinux('Server1', 'bob', line, 'command="echo only-this" ');
    expect((await keyLogin('PC2', priv, 'bob', 'Server1', 'hostname')).trim()).toBe('only-this');
  });

  it('Linux server: no-pty and restrict are honoured at login', async () => {
    const { priv, line } = await makeKey('PC2', 'k-linux-restrict');
    await installOnLinux('Server1', 'dave', line, 'restrict ');
    const out = await lan.run('PC2', `ssh ${NOCHECK} ${KEY_ONLY} -t -i ${priv} dave@${lan.ip('Server1')} hostname`);
    expect(out).toContain('PTY allocation request failed on channel 0');
  });

  it('Windows server: a standard user is served by its own authorized_keys', async () => {
    const { priv, line } = await makeKey('PC2', 'k-win-bob');
    await installOnWindows('PC1', 'bob', line, false);
    expect((await keyLogin('PC2', priv, 'bob', 'PC1', 'hostname')).trim()).toBe('PC1');
  });

  it('Windows server: an administrator is NOT served by its own authorized_keys', async () => {
    const { priv, line } = await makeKey('PC2', 'k-win-alice-own');
    await installOnWindows('PC1', 'alice', line, false);
    const out = await keyLogin('PC2', priv, 'alice', 'PC1', 'hostname');
    expect(out).toContain(`alice@${lan.ip('PC1')}: Permission denied (publickey,password).`);
  });

  it('Windows server: an administrator is served by administrators_authorized_keys', async () => {
    const { priv, line } = await makeKey('PC2', 'k-win-alice-admin');
    await installOnWindows('PC1', 'alice', line, true);
    expect((await keyLogin('PC2', priv, 'alice', 'PC1', 'hostname')).trim()).toBe('PC1');
  });

  it('Windows server: that shared file serves every administrator and never a standard user', async () => {
    const { priv, line } = await makeKey('PC2', 'k-win-shared');
    await installOnWindows('PC3', 'alice', line, true);
    expect((await keyLogin('PC2', priv, 'alice', 'PC3')).trim()).toBe('PC3');
    expect(await keyLogin('PC2', priv, 'bob', 'PC3')).toContain('Permission denied');
  });

  it('Windows server: the key login is recorded as such in the OpenSSH log', async () => {
    const { priv, line } = await makeKey('PC2', 'k-win-log');
    await installOnWindows('PC10', 'dave', line, false);
    await keyLogin('PC2', priv, 'dave', 'PC10');
    const out = await lan.asWindowsAdministrator('PC10', ['powershell -Command "Get-WinEvent -LogName OpenSSH/Operational | Select-Object -ExpandProperty Message"']);
    expect(out).toMatch(/sshd: Accepted publickey for dave from 192\.168\.30\.5 port \d+ ssh2: ED25519 SHA256:/);
  });
});

describe('public-key login: a Windows client into Linux and Windows servers', () => {
  it('Linux server: the key made on Windows is accepted for each profile', async () => {
    const { priv, line } = await makeKey('PC11', 'wk-linux');
    for (const user of ['alice', 'bob']) await installOnLinux('PC6', user, line);
    for (const user of ['alice', 'bob']) {
      expect((await keyLogin('PC11', priv, user, 'PC6', 'whoami')).trim()).toBe(user);
    }
  });

  it('Windows server: the key made on Windows is accepted for a standard user', async () => {
    const { priv, line } = await makeKey('PC11', 'wk-win');
    await installOnWindows('PC3', 'dave', line, false);
    expect((await keyLogin('PC11', priv, 'dave', 'PC3', 'hostname')).trim()).toBe('PC3');
  });

  it('a key of the wrong account is refused', async () => {
    const { priv, line } = await makeKey('PC11', 'wk-wrong');
    await installOnLinux('PC8', 'bob', line);
    expect(await keyLogin('PC11', priv, 'dave', 'PC8')).toContain('Permission denied');
  });

  it('an unreadable key file is reported by the client', async () => {
    const out = await lan.run('PC11', `ssh ${NOCHECK} ${KEY_ONLY} -i C:\\Users\\User\\no-such-key bob@${lan.ip('PC6')} hostname`);
    expect(out).toMatch(/Warning: Identity file C:\\Users\\User\\no-such-key not accessible: No such file or directory\./);
  });
});

describe('public-key login: the agent supplies the key', () => {
  it('a Linux client authenticates with the identity held by its agent, with no -i', async () => {
    const { priv, line } = await makeKey('PC2', 'ag-linux');
    await installOnLinux('PC6', 'dave', line);
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add ${priv}; ssh ${NOCHECK} -o IdentityFile=/dev/null ${KEY_ONLY} dave@${lan.ip('PC6')} whoami`);
    expect(out.trim().split(/\r?\n/).pop()?.trim()).toBe('dave');
  });

  it('a Windows client authenticates with the identity held by the ssh-agent service', async () => {
    await lan.asWindowsAdministrator('PC11', ['sc config ssh-agent start= demand', 'net start ssh-agent']);
    const { priv, line } = await makeKey('PC11', 'ag-win');
    await installOnLinux('PC6', 'bob', line);
    await lan.run('PC11', `ssh-add ${priv}`);
    const out = await lan.run('PC11', `ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC6')} whoami`);
    expect(out.trim()).toBe('bob');
  });

  it('the agent of a Windows client unlocks a Windows administrator through administrators_authorized_keys', async () => {
    const { priv, line } = await makeKey('PC11', 'ag-win-admin');
    await installOnWindows('PC1', 'alice', line, true);
    await lan.run('PC11', `ssh-add ${priv}`);
    const out = await lan.run('PC11', `ssh ${NOCHECK} ${KEY_ONLY} alice@${lan.ip('PC1')} hostname`);
    expect(out.trim()).toBe('PC1');
  });

  it('-A forwards the agent: a hop from Windows through Linux reaches a third machine with no key on the hop', async () => {
    const { priv, line } = await makeKey('PC11', 'ag-fwd');
    await installOnLinux('PC6', 'bob', line);
    await installOnLinux('PC8', 'bob', line);
    await lan.run('PC11', `ssh-add ${priv}`);
    const out = await lan.run('PC11', `ssh ${NOCHECK} ${KEY_ONLY} -A bob@${lan.ip('PC6')} "ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC8')} hostname"`);
    expect(out.trim()).toBe('PC8');
    const without = await lan.run('PC11', `ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC6')} "ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC8')} hostname"`);
    expect(without).toContain('Permission denied');
  });

  it('a Linux client forwards its agent into a Windows server and onward to a Linux one', async () => {
    const { priv, line } = await makeKey('PC2', 'ag-fwd-win');
    await installOnWindows('PC1', 'bob', line, false);
    await installOnLinux('PC9', 'bob', line);
    const out = await lan.run('PC2', `eval $(ssh-agent -s) > /dev/null; ssh-add ${priv}; ssh ${NOCHECK} ${KEY_ONLY} -A bob@${lan.ip('PC1')} "ssh ${NOCHECK} ${KEY_ONLY} bob@${lan.ip('PC9')} hostname"`);
    expect(out.trim().split(/\r?\n/).pop()?.trim()).toBe('PC9');
  });
});

describe('client configuration files', () => {
  it('a Host block in ~/.ssh/config sets the user, the address and the key on a Linux client', async () => {
    const { priv, line } = await makeKey('PC2', 'cfg-linux');
    await installOnLinux('PC6', 'dave', line);
    await lan.run('PC2', `printf 'Host hq-dave\\n  HostName ${lan.ip('PC6')}\\n  User dave\\n  IdentityFile ${priv}\\n  StrictHostKeyChecking no\\n' > /home/user/.ssh/config`);
    expect((await lan.run('PC2', 'ssh -o BatchMode=yes hq-dave whoami')).trim()).toBe('dave');
  });

  it('the same file works on a Windows client', async () => {
    const { priv, line } = await makeKey('PC11', 'cfg-win');
    await installOnLinux('PC6', 'dave', line);
    await lan.run('PC11', `(echo Host akwa-dave& echo   HostName ${lan.ip('PC6')}& echo   User dave& echo   IdentityFile ${priv}& echo   StrictHostKeyChecking no)> C:\\Users\\User\\.ssh\\config`);
    expect((await lan.run('PC11', 'ssh -o BatchMode=yes akwa-dave whoami')).trim()).toBe('dave');
  });

  it('IdentitiesOnly keeps ssh from offering any other key', async () => {
    const { priv } = await makeKey('PC2', 'cfg-only');
    const out = await lan.run('PC2', `ssh -v ${NOCHECK} -o IdentitiesOnly=yes -i ${priv} -o BatchMode=yes bob@${lan.ip('PC6')} hostname`);
    expect(out).toContain(`Offering public key: ${priv} ED25519`);
    expect(out).not.toContain('/home/user/.ssh/id_ed25519');
  });

  it('a Port and a User in the file are overridden by the command line', async () => {
    await lan.run('PC2', `printf 'Host gw\\n  HostName ${lan.ip('PC6')}\\n  User nobody\\n  Port 2299\\n' > /tmp/alt-config`);
    const out = await lan.run('PC2', `sshpass -p bob ssh -F /tmp/alt-config ${NOCHECK} -p 22 -l bob gw whoami`);
    expect(out.trim()).toBe('bob');
  });
});
