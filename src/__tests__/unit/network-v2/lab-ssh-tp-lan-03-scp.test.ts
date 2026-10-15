/**
 * Laboratoire SSH_TP_LAN : `scp` entre postes Linux et Windows de sites differents,
 * avec les quatre profils alice (administrateur) / bob (standard) / carl (ferme) /
 * dave (dossier prive).
 *
 * Les attentes viennent d'OpenSSH 8.9p1 (scp.c, protocole scp source/sink de l'ere
 * 8.x) et de Win32-OpenSSH 8.6 : chemins `C:/...` cote Windows, chemin relatif =
 * dossier personnel du compte, droits du compte appliques par le serveur.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const LINUX_TO_WINDOWS: ReadonlyArray<[string, string]> = [['PC2', 'PC1'], ['PC9', 'PC11'], ['PC6', 'PC3']];
const WINDOWS_TO_LINUX: ReadonlyArray<[string, string]> = [['PC11', 'PC6'], ['PC1', 'Server1'], ['PC4', 'PC8']];

const localDir = (host: string): string => (lan.platform(host) === 'linux' ? '/tmp' : 'C:\\Users\\User');
const sep = (host: string): string => (lan.platform(host) === 'linux' ? '/' : '\\');
const localPath = (host: string, name: string): string => `${localDir(host)}${sep(host)}${name}`;
const remoteHome = (user: string, server: string): string => (lan.platform(server) === 'linux' ? `/home/${user}` : `C:/Users/${user}`);

async function writeLocal(host: string, name: string, content: string): Promise<string> {
  const path = localPath(host, name);
  if (lan.platform(host) === 'linux') await lan.run(host, `printf '%s' '${content}' > ${path}`);
  else await lan.run(host, `echo ${content}> ${path}`);
  return path;
}

async function readLocal(host: string, path: string): Promise<string> {
  const out = lan.platform(host) === 'linux' ? await lan.run(host, `cat ${path}`) : await lan.asWindowsAdministrator(host, [`type ${path}`]);
  return out.replace(/\r?\n$/, '');
}

const scp = (client: string, user: string, args: string): Promise<string> =>
  lan.withPassword(client, `scp ${NOCHECK} ${args}`, user);

describe('scp: a file travels between Linux and Windows, in both directions, through the routers', () => {
  it.each(LINUX_TO_WINDOWS)('%s -> %s: upload as the administrator lands in the account home', async (client, server) => {
    const path = await writeLocal(client, 'up-a.txt', 'from-linux');
    const out = await scp(client, 'alice', `${path} alice@${lan.ip(server)}:up-a.txt`);
    expect(out).not.toMatch(/denied|refused|No such/i);
    expect(await readLocal(server, 'C:\\Users\\alice\\up-a.txt')).toBe('from-linux');
  });

  it.each(WINDOWS_TO_LINUX)('%s -> %s: upload as the administrator lands in the account home', async (client, server) => {
    const path = await writeLocal(client, 'up-b.txt', 'from-windows');
    const out = await scp(client, 'alice', `${path} alice@${lan.ip(server)}:up-b.txt`);
    expect(out).not.toMatch(/denied|refused|No such/i);
    expect(await readLocal(server, '/home/alice/up-b.txt')).toBe('from-windows');
  });

  it.each(LINUX_TO_WINDOWS)('%s <- %s: download from Windows', async (client, server) => {
    await lan.asWindowsAdministrator(server, ['echo from-windows-disk> C:\\Users\\bob\\down-a.txt']);
    const out = await scp(client, 'bob', `bob@${lan.ip(server)}:C:/Users/bob/down-a.txt ${localPath(client, 'down-a.txt')}`);
    expect(out).not.toMatch(/denied|refused|No such/i);
    expect((await readLocal(client, localPath(client, 'down-a.txt'))).trim()).toBe('from-windows-disk');
  });

  it.each(WINDOWS_TO_LINUX)('%s <- %s: download from Linux', async (client, server) => {
    await lan.run(server, "sudo sh -c \"echo from-linux-disk > /home/bob/down-b.txt; chown bob:bob /home/bob/down-b.txt\"", 'user\n');
    const out = await scp(client, 'bob', `bob@${lan.ip(server)}:/home/bob/down-b.txt ${localPath(client, 'down-b.txt')}`);
    expect(out).not.toMatch(/denied|refused|No such/i);
    expect((await readLocal(client, localPath(client, 'down-b.txt'))).trim()).toBe('from-linux-disk');
  });

  it('the same-platform control cases still work: Linux -> Linux and Windows -> Windows', async () => {
    const lx = await writeLocal('PC2', 'ctl-a.txt', 'lx-lx');
    await scp('PC2', 'alice', `${lx} alice@${lan.ip('PC6')}:ctl-a.txt`);
    expect(await readLocal('PC6', '/home/alice/ctl-a.txt')).toBe('lx-lx');
    const wn = await writeLocal('PC1', 'ctl-b.txt', 'wn-wn');
    await scp('PC1', 'alice', `${wn} alice@${lan.ip('PC11')}:ctl-b.txt`);
    expect((await readLocal('PC11', 'C:\\Users\\alice\\ctl-b.txt')).trim()).toBe('wn-wn');
  });

  it('the connection of an upload shows up as a session in the server journal', async () => {
    const path = await writeLocal('PC11', 'journal.txt', 'x');
    await scp('PC11', 'dave', `${path} dave@${lan.ip('PC6')}:journal.txt`);
    const auth = await lan.run('PC6', 'sudo grep "Accepted password for dave" /var/log/auth.log', 'user\n');
    expect(auth).toContain(`from ${lan.ip('PC11')} port`);
  });
});

describe('scp: paths and targets', () => {
  it('a relative remote path is relative to the home directory of the account that logged in', async () => {
    const path = await writeLocal('PC11', 'rel.txt', 'rel');
    await scp('PC11', 'bob', `${path} bob@${lan.ip('PC6')}:rel.txt`);
    await scp('PC11', 'dave', `${path} dave@${lan.ip('PC6')}:rel.txt`);
    expect((await lan.run('PC6', 'ls /home/bob/rel.txt /home/dave/rel.txt', undefined)).trim().split(/\s+/).sort()).toEqual(['/home/bob/rel.txt', '/home/dave/rel.txt']);
  });

  it('a remote directory target keeps the file name', async () => {
    const path = await writeLocal('PC2', 'keepname.txt', 'k');
    await scp('PC2', 'alice', `${path} alice@${lan.ip('PC1')}:C:/Users/alice/Documents/`);
    expect(await lan.asWindowsAdministrator('PC1', ['dir /b C:\\Users\\alice\\Documents'])).toContain('keepname.txt');
    await scp('PC2', 'alice', `${path} alice@${lan.ip('PC6')}:/tmp/`);
    expect(await lan.run('PC6', 'ls /tmp/keepname.txt')).toContain('/tmp/keepname.txt');
  });

  it('a remote file target renames the copy', async () => {
    const path = await writeLocal('PC11', 'orig.txt', 'o');
    await scp('PC11', 'alice', `${path} alice@${lan.ip('PC6')}:/tmp/renamed.txt`);
    expect(await readLocal('PC6', '/tmp/renamed.txt')).toBe('o');
  });

  it('the copy overwrites an existing file', async () => {
    const first = await writeLocal('PC2', 'over.txt', 'first');
    await scp('PC2', 'alice', `${first} alice@${lan.ip('PC6')}:/tmp/over-remote.txt`);
    const second = await writeLocal('PC2', 'over.txt', 'second-longer');
    await scp('PC2', 'alice', `${second} alice@${lan.ip('PC6')}:/tmp/over-remote.txt`);
    expect(await readLocal('PC6', '/tmp/over-remote.txt')).toBe('second-longer');
  });

  it('a file copied to Linux belongs to the account that logged in, with the account umask', async () => {
    const path = await writeLocal('PC11', 'owner.txt', 'z');
    await scp('PC11', 'bob', `${path} bob@${lan.ip('PC6')}:owner.txt`);
    expect((await lan.run('PC6', 'stat -c "%U:%G %a" /home/bob/owner.txt')).trim()).toBe('bob:bob 644');
  });

  it('several sources to one directory', async () => {
    const a = await writeLocal('PC2', 'multi-a.txt', 'a');
    const b = await writeLocal('PC2', 'multi-b.txt', 'b');
    await scp('PC2', 'alice', `${a} ${b} alice@${lan.ip('PC1')}:C:/Users/alice/Documents/`);
    const listing = await lan.asWindowsAdministrator('PC1', ['dir /b C:\\Users\\alice\\Documents']);
    expect(listing).toContain('multi-a.txt');
    expect(listing).toContain('multi-b.txt');
  });

  it('several sources to a target that does not exist are refused by the remote scp', async () => {
    const a = await writeLocal('PC2', 'amb-a.txt', 'a');
    const b = await writeLocal('PC2', 'amb-b.txt', 'b');
    const out = await scp('PC2', 'alice', `${a} ${b} alice@${lan.ip('PC6')}:/tmp/amb-target.txt`);
    expect(out).toContain('scp: /tmp/amb-target.txt: No such file or directory');
    expect(await lan.run('PC6', 'ls /tmp/amb-target.txt')).toContain('No such file');
  });

  it('several sources to an existing file are refused: it is not a directory', async () => {
    const a = await writeLocal('PC2', 'amb-c.txt', 'a');
    const b = await writeLocal('PC2', 'amb-d.txt', 'b');
    await lan.run('PC6', 'touch /tmp/amb-file.txt');
    const out = await scp('PC2', 'alice', `${a} ${b} alice@${lan.ip('PC6')}:/tmp/amb-file.txt`);
    expect(out).toContain('scp: /tmp/amb-file.txt: Not a directory');
  });

  it('an unquoted remote path with a space reaches the remote scp as two operands: ambiguous target', async () => {
    const a = await writeLocal('PC2', 'amb-e.txt', 'a');
    const out = await scp('PC2', 'alice', `${a} "alice@${lan.ip('PC6')}:/tmp/two words"`);
    expect(out).toContain('scp: ambiguous target');
  });

  it('a remote wildcard is expanded by the remote machine', async () => {
    await lan.run('PC6', 'sudo sh -c "echo 1 > /tmp/w-1.log; echo 2 > /tmp/w-2.log; chmod 644 /tmp/w-*.log"', 'user\n');
    const out = await scp('PC11', 'bob', `"bob@${lan.ip('PC6')}:/tmp/w-*.log" C:\\Users\\User\\`);
    expect(out).not.toMatch(/denied|No such/i);
    const listing = await lan.run('PC11', 'dir /b C:\\Users\\User');
    expect(listing).toContain('w-1.log');
    expect(listing).toContain('w-2.log');
  });

  it('a Windows drive letter is a local path, not a host', async () => {
    const out = await lan.run('PC11', 'scp C:\\Users\\User\\nothing.txt C:\\Users\\User\\other.txt');
    expect(out).not.toMatch(/ssh: |connect to host|Could not resolve/);
  });
});

describe('scp: directories', () => {
  it('-r copies a tree from Linux to Windows, keeping names and contents', async () => {
    await lan.run('PC2', "mkdir -p /tmp/tree/sub/deep && echo one > /tmp/tree/one.txt && echo two > /tmp/tree/sub/two.txt && echo three > /tmp/tree/sub/deep/three.txt");
    const out = await scp('PC2', 'alice', `-r /tmp/tree alice@${lan.ip('PC1')}:C:/Users/alice/`);
    expect(out).not.toMatch(/denied|No such/i);
    expect((await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\tree\\sub\\deep\\three.txt'])).trim()).toBe('three');
    expect((await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\tree\\one.txt'])).trim()).toBe('one');
  });

  it('-r copies a tree from Windows to Linux', async () => {
    await lan.run('PC11', 'mkdir C:\\Users\\User\\wtree\\inner');
    await lan.run('PC11', 'echo w1> C:\\Users\\User\\wtree\\w1.txt');
    await lan.run('PC11', 'echo w2> C:\\Users\\User\\wtree\\inner\\w2.txt');
    const out = await scp('PC11', 'alice', `-r C:\\Users\\User\\wtree alice@${lan.ip('PC6')}:/tmp/`);
    expect(out).not.toMatch(/denied|No such/i);
    expect((await lan.run('PC6', 'cat /tmp/wtree/inner/w2.txt')).trim()).toBe('w2');
    expect((await lan.run('PC6', 'cat /tmp/wtree/w1.txt')).trim()).toBe('w1');
  });

  it('a directory without -r is refused', async () => {
    const out = await scp('PC2', 'alice', `/tmp/tree alice@${lan.ip('PC6')}:/tmp/`);
    expect(out).toContain('scp: /tmp/tree: not a regular file');
  });

  it('-r downloads a tree from Windows to Linux', async () => {
    await lan.asWindowsAdministrator('PC1', ['mkdir C:\\Users\\bob\\album', 'echo p1> C:\\Users\\bob\\album\\p1.txt']);
    await scp('PC9', 'bob', `-r bob@${lan.ip('PC1')}:C:/Users/bob/album /tmp/`);
    expect((await lan.run('PC9', 'cat /tmp/album/p1.txt')).trim()).toBe('p1');
  });
});

describe('scp: options', () => {
  it('-P selects the port, and a closed port is refused', async () => {
    const path = await writeLocal('PC2', 'port.txt', 'p');
    const refused = await scp('PC2', 'alice', `-P 2299 ${path} alice@${lan.ip('PC6')}:/tmp/`);
    expect(refused).toContain(`ssh: connect to host ${lan.ip('PC6')} port 2299: Connection refused`);
    const ok = await scp('PC2', 'alice', `-P 22 ${path} alice@${lan.ip('PC6')}:/tmp/port.txt`);
    expect(ok).not.toContain('refused');
  });

  it('-p preserves the modification time', async () => {
    await lan.run('PC2', 'touch -d "2020-01-02 03:04:05" /tmp/old.txt');
    await scp('PC2', 'alice', `-p /tmp/old.txt alice@${lan.ip('PC6')}:/tmp/old-copy.txt`);
    expect((await lan.run('PC6', 'stat -c %y /tmp/old-copy.txt')).trim()).toMatch(/^2020-01-02 03:04:05/);
  });

  it('without -p the copy gets the time of the transfer', async () => {
    await scp('PC2', 'alice', `/tmp/old.txt alice@${lan.ip('PC6')}:/tmp/new-copy.txt`);
    expect((await lan.run('PC6', 'stat -c %y /tmp/new-copy.txt')).trim()).not.toMatch(/^2020-01-02/);
  });

  it('-q silences the progress meter', async () => {
    const path = await writeLocal('PC2', 'quiet.txt', 'q');
    const out = await scp('PC2', 'alice', `-q ${path} alice@${lan.ip('PC6')}:/tmp/quiet.txt`);
    expect(out.trim()).toBe('');
  });

  it('-v prints the OpenSSH debug transcript', async () => {
    const path = await writeLocal('PC2', 'verbose.txt', 'v');
    const out = await scp('PC2', 'alice', `-v ${path} alice@${lan.ip('PC1')}:verbose.txt`);
    expect(out).toContain('Executing: program /usr/bin/ssh host');
    expect(out).toContain('debug1: Authentication succeeded');
  });

  it('-o passes an ssh option through: a custom known_hosts file receives the host key', async () => {
    const path = await writeLocal('PC2', 'opt.txt', 'o');
    await lan.run('PC2', 'rm -f /tmp/scp-known');
    await scp('PC2', 'alice', `-o UserKnownHostsFile=/tmp/scp-known ${path} alice@${lan.ip('PC1')}:opt.txt`);
    expect(await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC1')} -f /tmp/scp-known`)).toContain(`# Host ${lan.ip('PC1')} found`);
  });

  it('-3 relays a copy between two remote hosts through the client, across the OS boundary', async () => {
    await lan.asWindowsAdministrator('PC1', ['echo relayed> C:\\Users\\alice\\relay.txt']);
    const out = await scp('PC2', 'alice', `-3 alice@${lan.ip('PC1')}:C:/Users/alice/relay.txt alice@${lan.ip('PC6')}:/tmp/relay.txt`);
    expect(out).not.toMatch(/denied|refused|No such/i);
    expect((await lan.run('PC6', 'cat /tmp/relay.txt')).trim()).toBe('relayed');
  });

  it('a Windows client reports its usage when nothing is given', async () => {
    const out = await lan.run('PC11', 'scp');
    expect(out).toContain('usage: scp');
  });
});

describe('scp: the rights of each profile apply on the server', () => {
  it('Linux: a standard user cannot write outside the places it owns', async () => {
    const path = await writeLocal('PC11', 'deny-a.txt', 'd');
    const out = await scp('PC11', 'bob', `${path} bob@${lan.ip('PC6')}:/etc/deny-a.txt`);
    expect(out).toContain('Permission denied');
    expect(await lan.run('PC6', 'ls /etc/deny-a.txt')).toContain('No such file or directory');
  });

  it('Linux: the same upload to /tmp is allowed to every profile that may log in', async () => {
    const path = await writeLocal('PC11', 'tmp-ok.txt', 't');
    for (const user of ['alice', 'bob', 'dave']) {
      const out = await scp('PC11', user, `${path} ${user}@${lan.ip('PC6')}:/tmp/tmp-ok-${user}.txt`);
      expect(out, user).not.toContain('Permission denied');
      expect(await lan.run('PC6', `stat -c %U /tmp/tmp-ok-${user}.txt`)).toContain(user);
    }
  });

  it('Linux: one account cannot read the private home of another', async () => {
    await lan.run('PC6', 'sudo sh -c "echo top-secret > /home/dave/secret.txt; chown dave:dave /home/dave/secret.txt; chmod 644 /home/dave/secret.txt"', 'user\n');
    const out = await scp('PC11', 'bob', `bob@${lan.ip('PC6')}:/home/dave/secret.txt C:\\Users\\User\\stolen.txt`);
    expect(out).toContain('Permission denied');
    expect(await lan.run('PC11', 'type C:\\Users\\User\\stolen.txt')).toContain('cannot find the file');
  });

  it('Linux: the owner reads it', async () => {
    await scp('PC11', 'dave', `dave@${lan.ip('PC6')}:/home/dave/secret.txt C:\\Users\\User\\mine.txt`);
    expect((await lan.run('PC11', 'type C:\\Users\\User\\mine.txt')).trim()).toBe('top-secret');
  });

  it('Linux: carl, whose shell is nologin, cannot copy anything', async () => {
    const path = await writeLocal('PC11', 'carl.txt', 'c');
    const out = await scp('PC11', 'carl', `${path} carl@${lan.ip('PC6')}:carl.txt`);
    expect(out).toMatch(/This account is currently not available|lost connection|Connection closed/);
    expect(await lan.run('PC6', 'ls /home/carl/carl.txt')).toContain('No such file');
  });

  it('Windows: a standard user cannot write to the system folder, the administrator can', async () => {
    const path = await writeLocal('PC2', 'sys.txt', 's');
    const bob = await scp('PC2', 'bob', `${path} bob@${lan.ip('PC1')}:C:/Windows/sys.txt`);
    expect(bob).toMatch(/Permission denied|Access is denied/);
    const alice = await scp('PC2', 'alice', `${path} alice@${lan.ip('PC1')}:C:/Windows/sys.txt`);
    expect(alice).not.toMatch(/denied/i);
    expect(await lan.run('PC1', 'type C:\\Windows\\sys.txt')).toContain('s');
  });

  it('Windows: one profile cannot be read by another standard user', async () => {
    await lan.asWindowsAdministrator('PC1', ['echo private-dave> C:\\Users\\dave\\mine.txt']);
    const bob = await scp('PC2', 'bob', `bob@${lan.ip('PC1')}:C:/Users/dave/mine.txt /tmp/spy.txt`);
    expect(bob).toMatch(/Permission denied|Access is denied/);
    expect(await lan.run('PC2', 'ls /tmp/spy.txt')).toContain('No such file');
    const dave = await scp('PC2', 'dave', `dave@${lan.ip('PC1')}:C:/Users/dave/mine.txt /tmp/own.txt`);
    expect(dave).not.toMatch(/denied/i);
    expect((await lan.run('PC2', 'cat /tmp/own.txt')).trim()).toBe('private-dave');
  });

  it('Windows: the disabled account carl is refused before any transfer', async () => {
    const path = await writeLocal('PC2', 'carl-w.txt', 'c');
    const out = await scp('PC2', 'carl', `${path} carl@${lan.ip('PC1')}:carl-w.txt`);
    expect(out).toContain(`carl@${lan.ip('PC1')}: Permission denied (publickey,password).`);
  });
});

describe('scp: failures are reported the way scp reports them', () => {
  it('a source that does not exist locally', async () => {
    const out = await scp('PC2', 'alice', `/tmp/nonexistent-file alice@${lan.ip('PC6')}:/tmp/`);
    expect(out).toContain('/tmp/nonexistent-file: No such file or directory');
  });

  it('a source that does not exist on the server', async () => {
    const out = await scp('PC2', 'alice', `alice@${lan.ip('PC6')}:/tmp/nonexistent-file /tmp/`);
    expect(out).toContain('scp: /tmp/nonexistent-file: No such file or directory');
  });

  it('a target directory that does not exist on the Windows server', async () => {
    const path = await writeLocal('PC2', 'nodir.txt', 'n');
    const out = await scp('PC2', 'alice', `${path} alice@${lan.ip('PC1')}:C:/NoSuchDir/nodir.txt`);
    expect(out).toMatch(/No such file or directory|Permission denied/);
  });

  it('a wrong password', async () => {
    const path = await writeLocal('PC2', 'badpw.txt', 'b');
    const out = await lan.run('PC2', `sshpass -p wrong scp ${NOCHECK} ${path} bob@${lan.ip('PC6')}:/tmp/`);
    expect(out).toContain(`bob@${lan.ip('PC6')}: Permission denied (publickey,password).`);
  });

  it('a host that does not answer', async () => {
    const path = await writeLocal('PC2', 'down.txt', 'd');
    const out = await lan.run('PC2', `scp ${NOCHECK} -o ConnectTimeout=3 ${path} alice@192.168.77.7:/tmp/`);
    expect(out).toMatch(/ssh: connect to host 192\.168\.77\.7 port 22: (No route to host|Connection timed out|Network is unreachable)/);
  });

  it('the exit status is 0 on success and 1 on failure', async () => {
    const path = await writeLocal('PC2', 'status.txt', 's');
    const good = await lan.run('PC2', `sshpass -p alice scp ${NOCHECK} ${path} alice@${lan.ip('PC6')}:/tmp/status.txt; echo rc=$?`);
    expect(good).toContain('rc=0');
    const bad = await lan.run('PC2', `sshpass -p alice scp ${NOCHECK} /tmp/missing-source alice@${lan.ip('PC6')}:/tmp/; echo rc=$?`);
    expect(bad).toContain('rc=1');
  });

  it('a stopped server refuses the connection', async () => {
    await lan.asWindowsAdministrator('PC3', ['net stop sshd']);
    const path = await writeLocal('PC2', 'stopped.txt', 's');
    const out = await scp('PC2', 'alice', `${path} alice@${lan.ip('PC3')}:stopped.txt`);
    await lan.asWindowsAdministrator('PC3', ['net start sshd']);
    expect(out).toContain('Connection refused');
  });
});

describe('scp: the contents arrive intact', () => {
  it('a multi-line text file keeps every line', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\\n');
    await lan.run('PC2', `printf '${body}\\n' > /tmp/big.txt`);
    await scp('PC2', 'alice', `/tmp/big.txt alice@${lan.ip('PC1')}:big.txt`);
    const back = await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\big.txt']);
    expect(back.trim().split(/\r?\n/)).toHaveLength(200);
    expect(back).toContain('line 200');
  });

  it('a file survives a round trip across both systems unchanged', async () => {
    await lan.run('PC2', "printf 'alpha\\nbeta\\ngamma\\n' > /tmp/round.txt");
    const before = (await lan.run('PC2', 'sha256sum /tmp/round.txt')).split(' ')[0];
    await scp('PC2', 'alice', `/tmp/round.txt alice@${lan.ip('PC1')}:round.txt`);
    await scp('PC2', 'alice', `alice@${lan.ip('PC1')}:round.txt /tmp/round-back.txt`);
    const after = (await lan.run('PC2', 'sha256sum /tmp/round-back.txt')).split(' ')[0];
    expect(after).toBe(before);
  });

  it('a binary file (a private key) keeps every byte', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /tmp/bin-key');
    await scp('PC2', 'alice', `/tmp/bin-key alice@${lan.ip('PC6')}:/tmp/bin-key-copy`);
    const a = (await lan.run('PC2', 'sha256sum /tmp/bin-key')).split(' ')[0];
    const b = (await lan.run('PC6', 'sha256sum /tmp/bin-key-copy')).split(' ')[0];
    expect(b).toBe(a);
  });

  it('every transfer crosses the cable: the server sees the client address', async () => {
    const path = await writeLocal('PC11', 'wire.txt', 'w');
    await scp('PC11', 'alice', `${path} alice@${lan.ip('PC6')}:wire.txt`);
    const journal = await lan.run('PC6', 'sudo grep "Accepted password for alice" /var/log/auth.log', 'user\n');
    expect(journal).toContain(`from ${lan.ip('PC11')} port`);
  });
});

describe('scp: the client command line', () => {
  it('an unknown option is refused with the getopt wording and the usage', async () => {
    const out = await lan.run('PC2', 'scp -x /tmp/a b');
    expect(out.split('\n')[0]).toBe("scp: invalid option -- 'x'");
    expect(out).toContain('usage: scp [-346BCpqrTv]');
  });

  it('a missing option argument is refused', async () => {
    const out = await lan.run('PC2', 'scp -P');
    expect(out.split('\n')[0]).toBe("scp: option requires an argument -- 'P'");
  });

  it('a single operand prints the usage on Windows as on Linux', async () => {
    const out = await lan.run('PC11', 'scp onlyone');
    expect(out).toContain('usage: scp [-346BCpqrTv]');
  });

  it('bundled switches and an attached value are understood: -rp -P22', async () => {
    await lan.run('PC2', 'mkdir -p /tmp/bundle && echo b > /tmp/bundle/b.txt');
    const out = await scp('PC2', 'alice', `-rp -P22 /tmp/bundle alice@${lan.ip('PC6')}:/tmp/`);
    expect(out).not.toMatch(/invalid|denied/i);
    expect((await lan.run('PC6', 'cat /tmp/bundle/b.txt')).trim()).toBe('b');
  });

  it('-l limits the bandwidth: the meter reports the time the limit imposes', async () => {
    await lan.run('PC2', "head -c 2000 /dev/zero | tr '\\0' 'x' > /tmp/limited.bin");
    const out = await scp('PC2', 'alice', `-l 16 /tmp/limited.bin alice@${lan.ip('PC6')}:/tmp/limited.bin`);
    expect(out).toContain('00:01');
  });

  it('-S names the ssh program: only ssh itself exists', async () => {
    const out = await scp('PC2', 'alice', `-S /bin/false /tmp/a alice@${lan.ip('PC6')}:/tmp/`);
    expect(out).toBe('exec: /bin/false: No such file or directory');
  });

  it('-p keeps the mode of the source, the default applies the umask of the receiver', async () => {
    await lan.run('PC2', 'echo m > /tmp/mode-src.txt && chmod 664 /tmp/mode-src.txt');
    await scp('PC2', 'alice', `/tmp/mode-src.txt alice@${lan.ip('PC6')}:/tmp/mode-plain.txt`);
    await scp('PC2', 'alice', `-p /tmp/mode-src.txt alice@${lan.ip('PC6')}:/tmp/mode-kept.txt`);
    expect((await lan.run('PC6', 'stat -c %a /tmp/mode-plain.txt')).trim()).toBe('644');
    expect((await lan.run('PC6', 'stat -c %a /tmp/mode-kept.txt')).trim()).toBe('664');
  });

  it('-p carries the time to a Windows server as well', async () => {
    await lan.run('PC2', 'touch -d "2019-05-06 07:08:09" /tmp/stamp-win.txt');
    await scp('PC2', 'alice', `-p /tmp/stamp-win.txt alice@${lan.ip('PC1')}:stamp-win.txt`);
    const listing = await lan.asWindowsAdministrator('PC1', ['dir C:\\Users\\alice\\stamp-win.txt']);
    expect(listing).toMatch(/05\/06\/2019|2019-05-06/);
  });

  it('a copy between two local paths needs no connection', async () => {
    await lan.run('PC2', 'echo local > /tmp/loc-a.txt');
    const out = await lan.run('PC2', 'scp /tmp/loc-a.txt /tmp/loc-b.txt');
    expect(out).not.toMatch(/ssh|connect/i);
    expect((await lan.run('PC2', 'cat /tmp/loc-b.txt')).trim()).toBe('local');
  });

  it('several remote sources land in a local directory', async () => {
    await lan.run('PC6', 'sudo sh -c "echo r1 > /tmp/rs-1.txt; echo r2 > /tmp/rs-2.txt; chmod 644 /tmp/rs-*.txt"', 'user\n');
    await lan.run('PC2', 'mkdir -p /tmp/rs-dest');
    await scp('PC2', 'alice', `alice@${lan.ip('PC6')}:/tmp/rs-1.txt alice@${lan.ip('PC6')}:/tmp/rs-2.txt /tmp/rs-dest`);
    expect((await lan.run('PC2', 'cat /tmp/rs-dest/rs-1.txt /tmp/rs-dest/rs-2.txt')).replace(/\s+/g, ' ').trim()).toBe('r1 r2');
  });

  it('several remote sources to a local file that is not a directory are refused', async () => {
    const out = await scp('PC2', 'alice', `alice@${lan.ip('PC6')}:/tmp/rs-1.txt alice@${lan.ip('PC6')}:/tmp/rs-2.txt /tmp/rs-1-local.txt`);
    expect(out).toContain('scp: /tmp/rs-1-local.txt: No such file or directory');
  });

  it('a remote-to-remote copy without -3 runs scp on the source host, which cannot answer a password', async () => {
    const out = await scp('PC2', 'alice', `alice@${lan.ip('PC6')}:/tmp/rs-1.txt alice@${lan.ip('PC8')}:/tmp/via-source.txt`);
    expect(out).toMatch(/Permission denied|Host key verification failed/);
    expect(await lan.run('PC8', 'ls /tmp/via-source.txt')).toContain('No such file');
  });
});

describe('scp: through a jump host', () => {
  it('-J reaches a server that only the jump host can see, Linux client', async () => {
    const path = await writeLocal('PC2', 'jumped.txt', 'j');
    const out = await scp('PC2', 'alice', `-J alice@${lan.ip('PC6')} ${path} alice@${lan.ip('PC1')}:jumped.txt`);
    expect(out).not.toMatch(/denied|refused|No such|closed/i);
    expect((await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\jumped.txt'])).trim()).toBe('j');
  });

  it('-J works from a Windows client too, and a wrong hop is reported', async () => {
    const path = await writeLocal('PC11', 'jumped-w.txt', 'jw');
    const good = await lan.run('PC11', `scp ${NOCHECK} -J alice@${lan.ip('PC6')} ${path} alice@${lan.ip('PC1')}:jumped-w.txt`, 'alice\nalice\n');
    expect(good).not.toMatch(/denied|refused|No such|closed/i);
    expect((await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\jumped-w.txt'])).trim()).toBe('jw');
    const bad = await lan.run('PC11', `scp ${NOCHECK} -J nobody@${lan.ip('PC6')} ${path} alice@${lan.ip('PC1')}:never.txt`, 'wrong\nalice\n');
    expect(bad).toContain(`nobody@${lan.ip('PC6')}: Permission denied (publickey,password).`);
  });
});
