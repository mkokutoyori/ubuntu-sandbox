/**
 * Laboratoire SSH_TP_LAN (export `SSH_TP_LAN.topology (7).json`) : le client `ssh`
 * entre postes Linux et Windows de sites differents, avec quatre comptes de
 * profils differents sur CHAQUE poste.
 *
 *   alice  administrateur  (Linux : groupe sudo      | Windows : groupe Administrators)
 *   bob    utilisateur     (Linux : sans sudo        | Windows : groupe Users)
 *   carl   compte ferme    (Linux : shell nologin    | Windows : compte desactive)
 *   dave   utilisateur dont le dossier personnel est prive (Linux : 700)
 *
 * Les trois sites sont relies par OSPF (HQ 192.168.30.0/24, Head Office
 * 192.168.10.0/24 + 192.168.20.0/24, Akwa 192.168.40.0/24 + 192.168.50.0/24) : un
 * saut Windows -> Linux ou Linux -> Windows traverse donc des routeurs, et chaque
 * octet passe par Port/Cable/TcpStack.
 *
 * Les outils reserves a un systeme ne sont pas testes sur l'autre (ssh-copy-id n'existe
 * pas sous Windows). Les attentes viennent d'OpenSSH 8.9p1 (Ubuntu 22.04) et de
 * Win32-OpenSSH 8.6 : source ssh.c, auth2.c, session.c, sshd.c.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

const lastLine = (text: string): string => text.trim().split('\n').pop() ?? '';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const WINDOWS_TO_LINUX: ReadonlyArray<[string, string]> = [['PC11', 'PC6'], ['PC1', 'Server1'], ['PC4', 'PC8']];
const LINUX_TO_WINDOWS: ReadonlyArray<[string, string]> = [['PC2', 'PC1'], ['PC9', 'PC11'], ['PC6', 'PC3']];
const CROSS_PLATFORM = [...WINDOWS_TO_LINUX, ...LINUX_TO_WINDOWS];

const remote = (client: string, user: string, server: string, command: string, extra = ''): string =>
  `ssh ${NOCHECK} ${extra} ${user}@${lan.ip(server)} ${command.length ? lan.quote(client, command) : ''}`.replace(/ {2,}/g, ' ').trim();

describe('the lab is what these tests assume', () => {
  it('has Linux and Windows machines on three routed sites', () => {
    expect(lan.names('linux').length).toBeGreaterThanOrEqual(6);
    expect(lan.names('windows').length).toBeGreaterThanOrEqual(5);
  });

  it.each(CROSS_PLATFORM)('%s reaches %s through the routers', async (client, server) => {
    const out = lan.platform(client) === 'windows'
      ? await lan.run(client, `ping -n 1 ${lan.ip(server)}`)
      : await lan.run(client, `ping -c 1 ${lan.ip(server)}`);
    expect(out).toMatch(/TTL=|ttl=/i);
  });

  it('gives every profile on every Linux machine and every Windows machine', async () => {
    expect(await lan.run('PC6', 'id bob')).not.toContain('27(sudo)');
    expect(await lan.run('PC6', 'id alice')).toContain('27(sudo)');
    expect(await lan.run('PC6', 'grep ^carl: /etc/passwd')).toContain('/usr/sbin/nologin');
    expect(await lan.run('PC1', 'net user carl')).toMatch(/Account active\s+No/);
    expect(await lan.run('PC1', 'net localgroup Administrators')).toContain('alice');
    expect(await lan.run('PC1', 'net localgroup Administrators')).not.toContain('bob');
  });
});

describe('ssh: a remote command runs on the machine that was named', () => {
  it.each(CROSS_PLATFORM)('%s -> %s: hostname answers with the server name', async (client, server) => {
    const out = await lan.withPassword(client, remote(client, 'alice', server, 'hostname'), 'alice');
    const own = await lan.run(server, 'hostname');
    expect(own.trim()).not.toBe('');
    expect(lastLine(out)).toBe(own.trim());
  });

  it.each(CROSS_PLATFORM)('%s -> %s: whoami names the account that logged in, for each profile', async (client, server) => {
    for (const user of ['alice', 'bob', 'dave']) {
      const out = await lan.withPassword(client, remote(client, user, server, 'whoami'), user);
      expect(out.trim().toLowerCase()).toMatch(new RegExp(`(^|\\\\)${user}$`));
    }
  });

  it.each(CROSS_PLATFORM)('%s -> %s: the command sees the account home directory', async (client, server) => {
    const probe = lan.platform(server) === 'linux' ? 'pwd' : 'cd';
    const out = await lan.withPassword(client, remote(client, 'bob', server, probe), 'bob');
    expect(out.trim().toLowerCase().replace(/\\/g, '/')).toMatch(lan.platform(server) === 'linux' ? /^\/home\/bob$/ : /^c:\/users\/bob$/);
  });

  it('a Linux client reaches a Windows shell: the remote command is parsed by cmd.exe', async () => {
    const out = await lan.withPassword('PC2', remote('PC2', 'alice', 'PC1', 'echo %USERNAME% & echo %COMPUTERNAME%'), 'alice');
    expect(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(['alice', 'PC1']);
  });

  it('a Windows client reaches a Linux shell: the remote command is parsed by bash', async () => {
    const out = await lan.withPassword('PC11', remote('PC11', 'alice', 'PC6', 'echo $USER; echo $HOME; echo $((6*7))'), 'alice');
    expect(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(['alice', '/home/alice', '42']);
  });

  it('standard output and a pipeline run entirely on the remote machine', async () => {
    const out = await lan.withPassword('PC11', remote('PC11', 'bob', 'PC6', 'hostname | tr a-z A-Z'), 'bob');
    expect(lastLine(out)).toBe('PC6');
  });
});

describe('ssh: the exit status of the remote command is the exit status of ssh', () => {
  it('Linux client, Linux command: exit 3', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC6')} 'exit 3'; echo rc=$?`);
    expect(out).toContain('rc=3');
  });

  it('Linux client, Windows command: exit 5', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC1')} 'exit 5'; echo rc=$?`);
    expect(out).toContain('rc=5');
  });

  it('Windows client, Linux command: errorlevel carries the status', async () => {
    await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC6')} "exit 4"`, 'alice\n');
    expect(lastLine((await lan.run('PC11', 'echo %errorlevel%')))).toBe('4');
  });

  it('Windows client, Windows command: errorlevel carries the status', async () => {
    await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC3')} "exit 6"`, 'alice\n');
    expect(lastLine((await lan.run('PC11', 'echo %errorlevel%')))).toBe('6');
  });

  it('Windows client, successful command: errorlevel is 0 again', async () => {
    await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC6')} "exit 4"`, 'alice\n');
    await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC6')} hostname`, 'alice\n');
    expect(lastLine((await lan.run('PC11', 'echo %errorlevel%')))).toBe('0');
  });

  it('Windows client, refused login: errorlevel is 255', async () => {
    await lan.run('PC11', `ssh ${NOCHECK} bob@${lan.ip('PC6')} hostname`, 'x\nx\nx\n');
    expect(lastLine((await lan.run('PC11', 'echo %errorlevel%')))).toBe('255');
  });

  it('Linux client, refused login: status 255', async () => {
    const out = await lan.run('PC2', `sshpass -p x ssh ${NOCHECK} bob@${lan.ip('PC6')} hostname; echo rc=$?`);
    expect(out).toContain('rc=255');
  });

  it('a successful command leaves status 0', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC1')} hostname >/dev/null; echo rc=$?`);
    expect(out).toContain('rc=0');
  });

  it('an unknown remote command fails with the remote shell wording', async () => {
    const linux = await lan.withPassword('PC11', remote('PC11', 'alice', 'PC6', 'no-such-tool'), 'alice');
    expect(linux).toContain('no-such-tool: command not found');
    const windows = await lan.withPassword('PC2', remote('PC2', 'alice', 'PC1', 'no-such-tool'), 'alice');
    expect(windows).toContain("'no-such-tool' is not recognized as an internal or external command");
  });
});

describe('ssh: each profile gets exactly the rights of its account', () => {
  it('Linux target: the sudoer elevates, the plain user does not', async () => {
    const alice = await lan.withPassword('PC11', remote('PC11', 'alice', 'PC6', 'sudo -n true; echo rc=$?'), 'alice');
    expect(alice).toContain('rc=0');
    const bob = await lan.withPassword('PC11', remote('PC11', 'bob', 'PC6', 'sudo -n true; echo rc=$?'), 'bob');
    expect(bob).not.toContain('rc=0');
    expect(bob).toMatch(/not in the sudoers file|a password is required/);
  });

  it('Linux target: a plain user cannot write under /etc, the administrator can through sudo', async () => {
    const bob = await lan.withPassword('PC1', remote('PC1', 'bob', 'PC6', 'touch /etc/lab-bob; echo rc=$?'), 'bob');
    expect(bob).toContain("touch: cannot touch '/etc/lab-bob': Permission denied");
    expect(bob).toContain('rc=1');
  });

  it('Linux target: a private home stays private to the other accounts', async () => {
    await lan.withPassword('PC11', remote('PC11', 'dave', 'PC6', 'echo secret > /home/dave/diary.txt'), 'dave');
    const bob = await lan.withPassword('PC11', remote('PC11', 'bob', 'PC6', 'cat /home/dave/diary.txt'), 'bob');
    expect(bob).toContain('cat: /home/dave/diary.txt: Permission denied');
    const dave = await lan.withPassword('PC11', remote('PC11', 'dave', 'PC6', 'cat /home/dave/diary.txt'), 'dave');
    expect(lastLine(dave)).toBe('secret');
  });

  it('Windows target: the administrator opens a privileged session, the plain user does not', async () => {
    const alice = await lan.withPassword('PC2', remote('PC2', 'alice', 'PC1', 'net session'), 'alice');
    expect(alice).not.toMatch(/Access is denied/);
    const bob = await lan.withPassword('PC2', remote('PC2', 'bob', 'PC1', 'net session'), 'bob');
    expect(bob).toMatch(/System error 5 has occurred\.\s+Access is denied\./);
  });

  it('Windows target: a plain user cannot read another profile, the administrator can', async () => {
    await lan.asWindowsAdministrator('PC1', ['echo secret> C:\\Users\\dave\\diary.txt']);
    const bob = await lan.withPassword('PC2', remote('PC2', 'bob', 'PC1', 'type C:\\Users\\dave\\diary.txt'), 'bob');
    expect(bob).toContain('Access is denied.');
    const alice = await lan.withPassword('PC2', remote('PC2', 'alice', 'PC1', 'type C:\\Users\\dave\\diary.txt'), 'alice');
    expect(lastLine(alice)).toBe('secret');
  });

  it('Windows target: group membership is what the session reports', async () => {
    const alice = await lan.withPassword('PC9', remote('PC9', 'alice', 'PC11', 'whoami /groups'), 'alice');
    expect(alice).toContain('BUILTIN\\Administrators');
    const bob = await lan.withPassword('PC9', remote('PC9', 'bob', 'PC11', 'whoami /groups'), 'bob');
    expect(bob).toContain('BUILTIN\\Users');
    expect(bob).not.toContain('BUILTIN\\Administrators');
  });
});

describe('ssh: authentication refusals', () => {
  it.each(CROSS_PLATFORM)('%s -> %s: a wrong password is refused with the OpenSSH wording', async (client, server) => {
    const command = remote(client, 'bob', server, 'hostname');
    const out = lan.platform(client) === 'linux'
      ? await lan.run(client, `sshpass -p nope ${command}`)
      : await lan.run(client, command, 'nope\nnope\nnope\n');
    expect(out).toContain(`bob@${lan.ip(server)}: Permission denied (publickey,password).`);
    expect(out).not.toContain(server);
  });

  it.each(CROSS_PLATFORM)('%s -> %s: an account that does not exist is refused the same way', async (client, server) => {
    const out = await lan.withPassword(client, remote(client, 'zed', server, 'hostname'), 'alice');
    expect(out).toContain(`zed@${lan.ip(server)}: Permission denied (publickey,password).`);
  });

  it('the disabled Windows account carl is refused, however good the password', async () => {
    const out = await lan.withPassword('PC2', remote('PC2', 'carl', 'PC1', 'hostname'), 'carl');
    expect(out).toContain(`carl@${lan.ip('PC1')}: Permission denied (publickey,password).`);
  });

  it('the Linux account carl, whose shell is nologin, is told so and runs nothing', async () => {
    const out = await lan.withPassword('PC11', remote('PC11', 'carl', 'PC6', 'whoami'), 'carl');
    expect(out).toContain('This account is currently not available.');
    expect(out.trim().split(/\r?\n/).pop()).not.toBe('carl');
  });

  it('an empty password is refused', async () => {
    const out = await lan.run('PC11', remote('PC11', 'bob', 'PC6', 'hostname'), '\n\n\n');
    expect(out).toContain('Permission denied');
  });

  it('a refused attempt leaves a Failed password line in the server journal', async () => {
    await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} bob@${lan.ip('PC6')} hostname`);
    const auth = await lan.run('PC6', 'sudo grep "Failed password for bob" /var/log/auth.log', 'user\n');
    expect(auth).toMatch(new RegExp(`Failed password for bob from ${lan.ip('PC2').replace(/\./g, '\\.')} port \\d+ ssh2`));
  });

  it('an unknown account is logged as Invalid user, with the address it came from', async () => {
    await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} zed@${lan.ip('PC6')} hostname`);
    const auth = await lan.run('PC6', 'sudo grep "Invalid user zed" /var/log/auth.log', 'user\n');
    expect(auth).toMatch(new RegExp(`Invalid user zed from ${lan.ip('PC2').replace(/\./g, '\\.')} port \\d+`));
  });

  it('a good login leaves an Accepted password line naming the client across the routers', async () => {
    await lan.withPassword('PC11', remote('PC11', 'alice', 'PC6', 'hostname'), 'alice');
    const auth = await lan.run('PC6', 'sudo grep "Accepted password for alice" /var/log/auth.log', 'user\n');
    expect(auth).toContain(`from ${lan.ip('PC11')} port`);
  });
});

describe('ssh: reachability and the way a connection fails', () => {
  it.each(CROSS_PLATFORM)('%s -> %s: a closed port is refused', async (client, server) => {
    const out = await lan.run(client, `ssh ${NOCHECK} -p 2299 alice@${lan.ip(server)} hostname`);
    expect(out).toContain(`ssh: connect to host ${lan.ip(server)} port 2299: Connection refused`);
  });

  it('a machine without an address on the path is unreachable', async () => {
    const out = await lan.run('PC2', `ssh ${NOCHECK} -o ConnectTimeout=3 alice@192.168.77.7 hostname`);
    expect(out).toMatch(/ssh: connect to host 192\.168\.77\.7 port 22: (No route to host|Connection timed out|Network is unreachable)/);
  });

  it('a stopped sshd refuses, a restarted one answers again (Windows server)', async () => {
    await lan.asWindowsAdministrator('PC3', ['net stop sshd']);
    const down = await lan.withPassword('PC2', remote('PC2', 'alice', 'PC3', 'hostname'), 'alice');
    expect(down).toContain('Connection refused');
    await lan.asWindowsAdministrator('PC3', ['net start sshd']);
    const up = await lan.withPassword('PC2', remote('PC2', 'alice', 'PC3', 'hostname'), 'alice');
    expect(lastLine(up)).toBe('PC3');
  });

  it('a stopped sshd refuses, a restarted one answers again (Linux server)', async () => {
    await lan.run('PC8', 'sudo systemctl stop ssh', 'user\n');
    const down = await lan.withPassword('PC11', remote('PC11', 'alice', 'PC8', 'hostname'), 'alice');
    expect(down).toContain('Connection refused');
    await lan.run('PC8', 'sudo systemctl start ssh', 'user\n');
    const up = await lan.withPassword('PC11', remote('PC11', 'alice', 'PC8', 'hostname'), 'alice');
    expect(lastLine(up)).toBe('PC8');
  });

  it('an alternate port works once the server listens on it', async () => {
    await lan.run('PC9', 'sudo sed -i "s/^#\\?Port 22/Port 2022/" /etc/ssh/sshd_config', 'user\n');
    await lan.run('PC9', 'sudo systemctl restart ssh', 'user\n');
    const out = await lan.withPassword('PC11', remote('PC11', 'alice', 'PC9', 'hostname', '-p 2022'), 'alice');
    expect(lastLine(out)).toBe('PC9');
    const old = await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC9')} hostname`, 'alice\n');
    expect(old).toContain('Connection refused');
  });
});

describe('ssh: client options', () => {
  it('-l names the account like user@host does', async () => {
    const out = await lan.run('PC2', `sshpass -p bob ssh ${NOCHECK} -l bob ${lan.ip('PC1')} whoami`);
    expect(out.trim().toLowerCase()).toMatch(/(^|\\)bob$/);
  });

  it('-p and -l together reach the right listener as the right account', async () => {
    const out = await lan.run('PC11', `ssh ${NOCHECK} -p 22 -l dave ${lan.ip('PC6')} whoami`, 'dave\n');
    expect(lastLine(out)).toBe('dave');
  });

  it('-v prints the OpenSSH debug transcript, naming the peer and the version', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh -v ${NOCHECK} alice@${lan.ip('PC1')} hostname`);
    expect(out).toContain('debug1: Connecting to');
    expect(out).toContain(`Remote protocol version 2.0, remote software version OpenSSH_for_Windows_8.6`);
    expect(out).toContain('Authenticated to');
  });

  it('-q hides the banner and the warnings', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh -q ${NOCHECK} alice@${lan.ip('PC1')} hostname`);
    expect(lastLine(out)).toBe('PC1');
    expect(out).not.toContain('Warning');
  });

  it('-o UserKnownHostsFile=<file> records the host there and nowhere else', async () => {
    await lan.run('PC2', 'rm -f /tmp/known-null');
    await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/known-null alice@${lan.ip('PC1')} hostname`);
    const out = await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC1')} -f /tmp/known-null`);
    expect(out).toContain(`# Host ${lan.ip('PC1')} found: line 1`);
  });

  it('-o BatchMode=yes refuses to prompt for a password', async () => {
    const out = await lan.run('PC2', `ssh -o BatchMode=yes ${NOCHECK} alice@${lan.ip('PC6')} hostname`);
    expect(out).toContain(`alice@${lan.ip('PC6')}: Permission denied (publickey,password).`);
  });

  it('-o PreferredAuthentications=password skips the offered keys', async () => {
    const out = await lan.run('PC11', `ssh -o PreferredAuthentications=password ${NOCHECK} alice@${lan.ip('PC6')} hostname`, 'alice\n');
    expect(lastLine(out)).toBe('PC6');
  });

  it('-T and -t are accepted with a remote command', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh -T ${NOCHECK} alice@${lan.ip('PC6')} hostname`);
    expect(lastLine(out)).toBe('PC6');
  });

  it('-4 and -6 select the address family', async () => {
    const four = await lan.run('PC2', `sshpass -p alice ssh -4 ${NOCHECK} alice@${lan.ip('PC6')} hostname`);
    expect(lastLine(four)).toBe('PC6');
  });

  it('a bad option is refused with the usage text', async () => {
    const out = await lan.run('PC2', 'ssh -Z');
    expect(out).toContain('unknown option -- Z');
    expect(out).toContain('usage: ssh');
  });

  it('ssh with no destination prints the usage', async () => {
    const out = await lan.run('PC11', 'ssh');
    expect(out).toContain('usage: ssh');
  });
});

describe('ssh: interactive sessions', () => {
  it('Linux -> Windows: the shell is cmd.exe in the account profile directory', async () => {
    const out = await lan.run('PC2', `ssh ${NOCHECK} alice@${lan.ip('PC1')}`, 'alice\ncd\nwhoami\nexit\n');
    expect(out).toContain('Microsoft Windows');
    expect(out).toContain('C:\\Users\\alice>');
    expect(out.toLowerCase()).toContain('pc1\\alice');
    expect(out).toContain(`Connection to ${lan.ip('PC1')} closed.`);
  });

  it('Windows -> Linux: the shell is bash in the account home directory', async () => {
    const out = await lan.run('PC11', `ssh ${NOCHECK} bob@${lan.ip('PC6')}`, 'bob\npwd\nid -un\nexit\n');
    expect(out).toContain('bob@PC6:~$');
    expect(out).toContain('/home/bob');
    expect(out).toContain(`Connection to ${lan.ip('PC6')} closed.`);
  });

  it('state is kept inside one session: cd then relative file access', async () => {
    const out = await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC6')}`, 'alice\nmkdir -p work && cd work && echo hi > a.txt\ncat a.txt\npwd\nexit\n');
    expect(out).toContain('hi');
    expect(out).toContain('/home/alice/work');
  });

  it('two sessions of two accounts on one server do not share their working directory', async () => {
    await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC6')}`, 'alice\ncd /tmp\nexit\n');
    const out = await lan.run('PC11', `ssh ${NOCHECK} bob@${lan.ip('PC6')}`, 'bob\npwd\nexit\n');
    expect(out).toContain('/home/bob');
  });

  it('the exit status of the last command does not leak across sessions', async () => {
    const out = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC6')} 'echo $?'`);
    expect(lastLine(out)).toBe('0');
  });

  it('logout closes the connection and the server logs the end of the session', async () => {
    await lan.run('PC2', `ssh ${NOCHECK} bob@${lan.ip('PC6')}`, 'bob\nexit\n');
    const out = await lan.run('PC6', 'sudo grep "session closed for user bob" /var/log/auth.log', 'user\n');
    expect(out).toContain('pam_unix(sshd:session): session closed for user bob');
  });
});

describe('ssh: the host key and known_hosts', () => {
  it('accept-new records the key of a Windows server on first contact, hashed as Ubuntu does', async () => {
    await lan.run('PC9', 'rm -f /home/user/.ssh/known_hosts');
    const first = await lan.run('PC9', `ssh -o StrictHostKeyChecking=accept-new alice@${lan.ip('PC10')}`, 'alice\nexit\n');
    expect(first).toContain(`Warning: Permanently added '${lan.ip('PC10')}' (ED25519) to the list of known hosts.`);
    expect(await lan.run('PC9', 'cat /home/user/.ssh/known_hosts')).toMatch(/^\|1\|\S+\|\S+ ssh-ed25519 AAAA/);
    const second = await lan.run('PC9', `ssh -o StrictHostKeyChecking=accept-new alice@${lan.ip('PC10')} hostname`, 'alice\n');
    expect(second).not.toContain('Permanently added');
    expect(lastLine(second)).toBe('PC10');
  });

  it('the recorded key is the one the Windows server really holds', async () => {
    const found = await lan.run('PC9', `ssh-keygen -F ${lan.ip('PC10')}`);
    const pub = await lan.asWindowsAdministrator('PC10', ['type C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub']);
    const blob = pub.trim().split(/\s+/)[1];
    expect(found).toContain(`ssh-ed25519 ${blob}`);
  });

  it('a Windows client asks before trusting a Linux key, and refuses on no', async () => {
    await lan.run('PC4', 'del /q C:\\Users\\User\\.ssh\\known_hosts');
    const out = await lan.run('PC4', `ssh -o StrictHostKeyChecking=ask alice@${lan.ip('PC5')} hostname`, 'no\n');
    expect(out).toContain(`The authenticity of host '${lan.ip('PC5')} (${lan.ip('PC5')})' can't be established.`);
    expect(out).toContain('ED25519 key fingerprint is SHA256:');
    expect(out).toContain('Are you sure you want to continue connecting (yes/no/[fingerprint])?');
    expect(out).toContain('Host key verification failed.');
  });

  it('answering yes records the key and the command then runs', async () => {
    await lan.run('PC4', 'del /q C:\\Users\\User\\.ssh\\known_hosts');
    const out = await lan.run('PC4', `ssh -o StrictHostKeyChecking=ask alice@${lan.ip('PC5')} hostname`, 'yes\nalice\n');
    expect(out).toContain(`Warning: Permanently added '${lan.ip('PC5')}' (ED25519) to the list of known hosts.`);
    expect(out.trim().split(/\r?\n/).pop()?.trim()).toBe('PC5');
  });

  it('a changed server key stops the connection with the OpenSSH warning', async () => {
    await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=accept-new alice@${lan.ip('PC5')} hostname`);
    await lan.run('PC5', 'sudo rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub', 'user\n');
    await lan.run('PC5', 'sudo ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key', 'user\n');
    await lan.run('PC5', 'sudo systemctl restart ssh', 'user\n');
    const out = await lan.run('PC2', `sshpass -p alice ssh alice@${lan.ip('PC5')} hostname`);
    expect(out).toContain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!');
    expect(out).toContain('Host key verification failed.');
    expect(out).not.toContain('PC5\n');
  });
});
