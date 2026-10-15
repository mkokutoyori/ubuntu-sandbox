/**
 * Laboratoire SSH_TP_LAN : `sftp` et le sous-systeme `sftp-server` entre postes Linux et
 * Windows de sites differents, avec les profils alice / bob / carl / dave.
 *
 * Attentes tirees de sftp.c (8.9p1 : `sftp> cmd` en mode lot, pas d'invite finale,
 * `ls` cache les noms commencant par `.`, `Fetching`/`Uploading`/`Removing`, messages
 * `File "x" not found.`, `remote open("x"): Permission denied`), de sftp-server.c
 * (options -R -d -u -l, mode lecture seule) et de session.c (`subsystem request
 * failed`, sous-systeme lance par le shell du compte, `internal-sftp`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const LINUX_CLIENTS_WINDOWS_SERVERS: ReadonlyArray<[string, string]> = [['PC2', 'PC1'], ['PC9', 'PC11'], ['PC6', 'PC3']];
const WINDOWS_CLIENTS_LINUX_SERVERS: ReadonlyArray<[string, string]> = [['PC11', 'PC6'], ['PC1', 'Server1'], ['PC4', 'PC8']];
const ALL_PAIRS = [...LINUX_CLIENTS_WINDOWS_SERVERS, ...WINDOWS_CLIENTS_LINUX_SERVERS];

const sudo = (host: string, command: string): Promise<string> => lan.run(host, `sudo ${command}`, 'user\n');
const workdir = (client: string): string => (lan.platform(client) === 'linux' ? '/tmp' : 'C:\\Users\\User');
const at = (client: string, name: string): string => `${workdir(client)}${lan.platform(client) === 'linux' ? '/' : '\\'}${name}`;
const remoteHome = (server: string, user: string): string => (lan.platform(server) === 'linux' ? `/home/${user}` : `/C:/Users/${user}`);

async function sftpBatch(client: string, user: string, server: string, commands: string[], extra = '-N'): Promise<string> {
  const file = at(client, `batch-${Math.abs(commands.join('|').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}.txt`);
  if (lan.platform(client) === 'linux') {
    await lan.run(client, `printf '%s\\n' ${commands.map((c) => `'${c}'`).join(' ')} > ${file}`);
  } else {
    await lan.run(client, `(${commands.map((c) => `echo ${c}`).join('& ')})> ${file}`);
  }
  return lan.withPassword(client, `sftp ${NOCHECK} -o BatchMode=no ${extra} -b ${file} ${user}@${lan.ip(server)}`.replace(/ {2,}/g, ' '), user);
}

describe('sftp: opening a session', () => {
  it.each(ALL_PAIRS)('%s -> %s: connects, echoes each batch command, and leaves no prompt behind', async (client, server) => {
    const out = await sftpBatch(client, 'alice', server, ['pwd', 'bye']);
    expect(out).toContain(`Connected to ${lan.ip(server)}.`);
    expect(out).toContain('sftp> pwd');
    expect(out).toContain(`Remote working directory: ${remoteHome(server, 'alice')}`);
    expect(out.trimEnd().endsWith('sftp> ')).toBe(false);
  });

  it.each(ALL_PAIRS)('%s -> %s: a refused password never reaches the prompt', async (client, server) => {
    const file = at(client, 'refused-batch.txt');
    if (lan.platform(client) === 'linux') await lan.run(client, `echo pwd > ${file}`);
    else await lan.run(client, `echo pwd> ${file}`);
    const out = lan.platform(client) === 'linux'
      ? await lan.run(client, `sshpass -p nope sftp ${NOCHECK} -b ${file} bob@${lan.ip(server)}`)
      : await lan.run(client, `sftp ${NOCHECK} -b ${file} bob@${lan.ip(server)}`, 'nope\nnope\nnope\n');
    expect(out).toContain(`bob@${lan.ip(server)}: Permission denied (publickey,password).`);
    expect(out).not.toContain('Connected to');
  });

  it('a Linux client reading commands from a pipe echoes them as a batch does', async () => {
    const out = await lan.run('PC2', `printf 'pwd\\nls\\nbye\\n' | sshpass -p alice sftp ${NOCHECK} alice@${lan.ip('PC6')}`);
    expect(out).toContain('sftp> pwd');
    expect(out).toContain('Remote working directory: /home/alice');
  });

  it('the usage is printed when no destination is given', async () => {
    const out = await lan.run('PC2', 'sftp');
    expect(out).toContain('usage: sftp [-46AaCfNpqrv] [-B buffer_size] [-b batchfile] [-c cipher]');
  });

  it('-P selects the port and a closed one is refused', async () => {
    const out = await lan.run('PC2', `sftp ${NOCHECK} -P 2299 alice@${lan.ip('PC6')}`);
    expect(out).toContain(`ssh: connect to host ${lan.ip('PC6')} port 2299: Connection refused`);
  });

  it('-q hides the Connected line', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC6', ['pwd'], '-q');
    expect(out).not.toContain('Connected to');
    expect(out).toContain('Remote working directory: /home/alice');
  });

  it('the session shows up in the server journal as an sftp subsystem request', async () => {
    await sftpBatch('PC11', 'dave', 'PC6', ['pwd']);
    const journal = await sudo('PC6', 'grep "subsystem request for sftp by user dave" /var/log/auth.log');
    expect(journal).toContain('subsystem request for sftp by user dave');
  });
});

describe('sftp: navigating', () => {
  it.each(ALL_PAIRS)('%s -> %s: cd then pwd, lcd then lpwd', async (client, server) => {
    const target = lan.platform(server) === 'linux' ? '/tmp' : '/C:/Users/Public';
    const out = await sftpBatch(client, 'alice', server, [`cd ${target}`, 'pwd', `lcd ${workdir(client)}`, 'lpwd']);
    expect(out).toContain(`Remote working directory: ${target}`);
    expect(out).toContain(`Local working directory: ${workdir(client)}`);
  });

  it('cd into a directory that does not exist is refused', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC6', ['cd /no/such/dir']);
    expect(out).toContain('realpath /no/such/dir: No such file');
  });

  it('cd into a file is refused', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC6', ['cd /etc/hostname']);
    expect(out).toContain('Can\'t change directory: "/etc/hostname" is not a directory');
  });

  it('ls hides names starting with a dot, ls -a shows them', async () => {
    await sudo('PC6', 'sh -c "echo v > /home/bob/visible.txt; echo h > /home/bob/.hidden; chown bob:bob /home/bob/visible.txt /home/bob/.hidden"');
    const plain = await sftpBatch('PC11', 'bob', 'PC6', ['ls']);
    expect(plain).toContain('visible.txt');
    expect(plain).not.toContain('.hidden');
    const all = await sftpBatch('PC11', 'bob', 'PC6', ['ls -a']);
    expect(all).toContain('.hidden');
    expect(all).toMatch(/(^|\s)\.\.?(\s|$)/m);
  });

  it('ls -l of a directory prints the long names the server composes: owner and group by name', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['ls -l']);
    expect(out).toMatch(/-rw-r--r--\s+1\s+bob\s+bob\s+2\s+\w{3}\s+\d+\s+[\d:]+\s+visible\.txt/);
  });

  it('ls -l of a single name prints what the client composes from the attributes: numeric ids and ? links', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['ls -l visible.txt']);
    expect(out).toMatch(/-rw-r--r--\s+\?\s+\d+\s+\d+\s+2\s+\w{3}\s+\d+\s+[\d:]+\s+visible\.txt/);
  });

  it('ls with a pattern lists only the matching names', async () => {
    await sudo('PC6', 'sh -c "echo 1 > /home/bob/p1.log; echo 2 > /home/bob/p2.log; chown bob:bob /home/bob/p?.log"');
    const out = await sftpBatch('PC2', 'bob', 'PC6', ['ls p*.log']);
    expect(out).toContain('p1.log');
    expect(out).toContain('p2.log');
    expect(out).not.toContain('visible.txt');
  });

  it('ls of a missing name says so', async () => {
    const out = await sftpBatch('PC2', 'bob', 'PC6', ['ls nothing-here']);
    expect(out).toContain('Can\'t ls: "/home/bob/nothing-here" not found');
  });

  it('a Windows server lists its folders in a Windows account home', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC1', ['ls']);
    for (const folder of ['Desktop', 'Documents', 'Downloads']) expect(out).toContain(folder);
    expect(out).not.toMatch(/(^|\s)NTUSER/);
  });
});

describe('sftp: transferring files', () => {
  it.each(ALL_PAIRS)('%s -> %s: put then get returns the same bytes, and says what it does', async (client, server) => {
    const local = at(client, 'rt.txt');
    if (lan.platform(client) === 'linux') await lan.run(client, `printf 'round-trip\\n' > ${local}`);
    else await lan.run(client, `echo round-trip> ${local}`);
    const back = at(client, 'rt-back.txt');
    const out = await sftpBatch(client, 'bob', server, [`put ${local} rt-remote.txt`, `get rt-remote.txt ${back}`]);
    expect(out).toContain(`Uploading ${local} to ${remoteHome(server, 'bob')}/rt-remote.txt`);
    expect(out).toContain(`Fetching ${remoteHome(server, 'bob')}/rt-remote.txt to ${back}`);
    const content = lan.platform(client) === 'linux' ? await lan.run(client, `cat ${back}`) : await lan.run(client, `type ${back}`);
    expect(content.trim()).toBe('round-trip');
  });

  it('get without a local name keeps the remote name in the local directory', async () => {
    await sudo('PC6', 'sh -c "echo keepname > /home/bob/keepname.txt; chown bob:bob /home/bob/keepname.txt"');
    await sftpBatch('PC11', 'bob', 'PC6', [`lcd C:\\Users\\User`, 'get keepname.txt']);
    expect((await lan.run('PC11', 'type C:\\Users\\User\\keepname.txt')).trim()).toBe('keepname');
  });

  it('get and put accept a glob and transfer each match', async () => {
    await sudo('PC6', 'sh -c "echo a > /home/bob/g-a.dat; echo b > /home/bob/g-b.dat; chown bob:bob /home/bob/g-?.dat"');
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['lcd C:\\Users\\User', 'get g-*.dat']);
    expect(out).toContain('Fetching /home/bob/g-a.dat to g-a.dat');
    expect(out).toContain('Fetching /home/bob/g-b.dat to g-b.dat');
    expect((await lan.run('PC11', 'type C:\\Users\\User\\g-b.dat')).trim()).toBe('b');
  });

  it('put -r and get -r move whole trees', async () => {
    await lan.run('PC2', 'mkdir -p /tmp/stree/inner && echo s1 > /tmp/stree/s1.txt && echo s2 > /tmp/stree/inner/s2.txt');
    await sftpBatch('PC2', 'alice', 'PC1', ['put -r /tmp/stree']);
    expect((await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\stree\\inner\\s2.txt'])).trim()).toBe('s2');
    await sftpBatch('PC9', 'alice', 'PC1', ['lcd /tmp', 'get -r stree']);
    expect((await lan.run('PC9', 'cat /tmp/stree/s1.txt')).trim()).toBe('s1');
  });

  it('put without -r on a directory is refused', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC6', ['put /tmp/stree']);
    expect(out).toMatch(/not a regular file|stree.*(is a directory|not a regular file)/);
  });

  it('get of a file that does not exist says so, and the batch stops there', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['get nofile.txt', 'pwd']);
    expect(out).toContain('File "/home/bob/nofile.txt" not found.');
    expect(out).not.toContain('Remote working directory');
  });

  it('a command prefixed with - may fail without stopping the batch', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['-get nofile.txt', 'pwd']);
    expect(out).toContain('File "/home/bob/nofile.txt" not found.');
    expect(out).toContain('Remote working directory: /home/bob');
  });

  it('a transfer of many lines arrives complete', async () => {
    await lan.run('PC2', "printf '%s\\n' $(seq 1 500) > /tmp/many.txt");
    await sftpBatch('PC2', 'alice', 'PC1', ['put /tmp/many.txt']);
    const back = await lan.asWindowsAdministrator('PC1', ['type C:\\Users\\alice\\many.txt']);
    expect(back.trim().split(/\r?\n/)).toHaveLength(500);
  });

  it('the file put on a Linux server belongs to the account that logged in', async () => {
    await lan.run('PC11', 'echo mine> C:\\Users\\User\\mine.txt');
    await sftpBatch('PC11', 'dave', 'PC6', ['put C:\\Users\\User\\mine.txt']);
    expect((await lan.run('PC6', 'stat -c "%U:%G" /home/dave/mine.txt')).trim()).toBe('dave:dave');
  });
});

describe('sftp: managing the remote tree', () => {
  it('mkdir, rename, rmdir and rm act on a Linux server and report what they remove', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['mkdir made', 'rename made renamed', 'rmdir renamed', 'put C:\\Users\\User\\keepname.txt gone.txt', 'rm gone.txt']);
    expect(out).toContain('Removing /home/bob/gone.txt');
    expect(await lan.run('PC6', 'ls /home/bob')).not.toMatch(/\b(made|renamed|gone\.txt)\b/);
  });

  it('mkdir, rename and rm act on a Windows server', async () => {
    const out = await sftpBatch('PC2', 'bob', 'PC1', ['mkdir made', 'rename made renamed', 'put /tmp/many.txt temp.txt', 'rm temp.txt', 'rmdir renamed']);
    expect(out).toContain('Removing /C:/Users/bob/temp.txt');
    const listing = await lan.run('PC1', 'dir /b C:\\Users\\bob');
    expect(listing).not.toMatch(/made|renamed|temp\.txt/);
  });

  it('mkdir of a name that exists is refused', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['mkdir again', '-mkdir again']);
    expect(out).toContain('remote mkdir "/home/bob/again": Failure');
  });

  it('rmdir of a directory that is not empty is refused', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['mkdir full', 'put C:\\Users\\User\\keepname.txt full/inside.txt', 'rmdir full']);
    expect(out).toMatch(/remote rmdir "\/home\/bob\/full": (Failure|Directory not empty)/);
  });

  it('chmod changes the mode on a Linux server, and says so', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['chmod 600 keepname.txt']);
    expect(out).toContain('Changing mode on /home/bob/keepname.txt');
    expect((await lan.run('PC6', 'stat -c %a /home/bob/keepname.txt')).trim()).toBe('600');
  });

  it('chown to another account is refused to a standard user', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['chown 1001 keepname.txt']);
    expect(out).toContain('Permission denied');
  });

  it('ln -s creates a symbolic link on a Linux server', async () => {
    await sftpBatch('PC11', 'bob', 'PC6', ['ln -s keepname.txt linkname.txt']);
    expect((await lan.run('PC6', 'readlink /home/bob/linkname.txt')).trim()).toBe('keepname.txt');
  });

  it('df reports the file system of a Linux server', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['df -h']);
    expect(out).toMatch(/Size\s+Used\s+Avail\s+\(root\)\s+%Capacity/);
  });

  it('version reports protocol 3', async () => {
    expect(await sftpBatch('PC11', 'bob', 'PC6', ['version'])).toContain('SFTP protocol version 3');
    expect(await sftpBatch('PC2', 'bob', 'PC1', ['version'])).toContain('SFTP protocol version 3');
  });

  it('! runs a command on the client machine, whatever its system', async () => {
    expect(await sftpBatch('PC2', 'alice', 'PC6', ['!hostname'])).toContain((await lan.run('PC2', 'hostname')).trim());
    expect(await sftpBatch('PC11', 'alice', 'PC6', ['!hostname'])).toContain((await lan.run('PC11', 'hostname')).trim());
  });

  it('an unknown command is reported and stops a batch', async () => {
    expect(await sftpBatch('PC2', 'alice', 'PC6', ['frobnicate'])).toContain('Invalid command.');
  });

  it('help lists the available commands', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC6', ['help']);
    expect(out).toContain('Available commands:');
    expect(out).toContain('get [-afpR] remote [local]');
    expect(out).toContain('put [-afpR] local [remote]');
  });
});

describe('sftp: the rights of each profile apply', () => {
  it('Linux: a standard user cannot upload outside the places it owns', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['put C:\\Users\\User\\keepname.txt /etc/denied.txt']);
    expect(out).toContain('dest open "/etc/denied.txt": Permission denied');
  });

  it('Linux: a file in another private home cannot even be looked up, so the glob finds nothing', async () => {
    await sudo('PC6', 'sh -c "echo sealed > /home/dave/sealed.txt; chown dave:dave /home/dave/sealed.txt"');
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['get /home/dave/sealed.txt C:\\Users\\User\\sealed.txt']);
    expect(out).toContain('File "/home/dave/sealed.txt" not found.');
  });

  it('Linux: a file that can be found but not read is refused at open with the status text', async () => {
    await sudo('PC6', 'sh -c "echo hidden > /tmp/dave-only.bin; chown dave:dave /tmp/dave-only.bin; chmod 600 /tmp/dave-only.bin"');
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['get /tmp/dave-only.bin C:\\Users\\User\\dave-only.bin']);
    expect(out).toContain('remote open "/tmp/dave-only.bin": Permission denied');
  });

  it('Linux: nor list that home', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['ls /home/dave']);
    expect(out).toContain('remote readdir("/home/dave/"): Permission denied');
  });

  it('Linux: the owner and the administrator through sudo see it', async () => {
    const out = await sftpBatch('PC11', 'dave', 'PC6', ['ls /home/dave']);
    expect(out).toContain('sealed.txt');
  });

  it('Linux: a standard user cannot delete a system file', async () => {
    const out = await sftpBatch('PC11', 'bob', 'PC6', ['rm /etc/hostname']);
    expect(out).toContain('remote delete /etc/hostname: Permission denied');
  });

  it('Linux: carl, whose shell is nologin, gets no sftp session', async () => {
    const out = await sftpBatch('PC11', 'carl', 'PC6', ['pwd']);
    expect(out).toContain('Received message too long 1416128883');
    expect(out).toContain('Ensure the remote shell produces no output for non-interactive sessions.');
    expect(out).not.toContain('Remote working directory');
  });

  it('Windows: a standard user cannot write to the system folder', async () => {
    const out = await sftpBatch('PC2', 'bob', 'PC1', ['put /tmp/many.txt /C:/Windows/denied.txt']);
    expect(out).toContain('dest open "/C:/Windows/denied.txt": Permission denied');
  });

  it('Windows: a standard user cannot read another profile, the owner can', async () => {
    await lan.asWindowsAdministrator('PC1', ['echo private> C:\\Users\\dave\\notes.txt']);
    const bob = await sftpBatch('PC2', 'bob', 'PC1', ['get /C:/Users/dave/notes.txt /tmp/notes-stolen.txt']);
    expect(bob).toContain('remote open "/C:/Users/dave/notes.txt": Permission denied');
    const dave = await sftpBatch('PC2', 'dave', 'PC1', ['get notes.txt /tmp/notes-own.txt']);
    expect(dave).not.toMatch(/denied/i);
    expect((await lan.run('PC2', 'cat /tmp/notes-own.txt')).trim()).toBe('private');
  });

  it('Windows: the disabled account carl is refused at the door', async () => {
    const out = await sftpBatch('PC2', 'carl', 'PC1', ['pwd']);
    expect(out).toContain(`carl@${lan.ip('PC1')}: Permission denied (publickey,password).`);
  });

  it('Windows: the administrator may write the system folder', async () => {
    const out = await sftpBatch('PC2', 'alice', 'PC1', ['put /tmp/many.txt /C:/Windows/allowed.txt']);
    expect(out).not.toMatch(/denied/i);
    expect(await lan.run('PC1', 'dir /b C:\\Windows')).toContain('allowed.txt');
  });
});

describe('sftp-server: the program behind the subsystem', () => {
  it('is installed where sshd_config says, as an executable file', async () => {
    const out = await lan.run('PC6', 'ls -l /usr/lib/openssh/sftp-server');
    expect(out).toMatch(/^-rwxr-xr-x 1 root root \d+ .* \/usr\/lib\/openssh\/sftp-server/);
  });

  it('prints its usage on -h', async () => {
    const out = await lan.run('PC6', '/usr/lib/openssh/sftp-server -h; echo rc=$?');
    expect(out).toContain('usage: sftp-server [-ehR] [-d start_directory] [-f log_facility] [-l log_level]');
    expect(out).toContain('[-P denied_requests] [-p allowed_requests] [-u umask]');
    expect(out).toContain('rc=1');
  });

  it('is shipped by Windows as sftp-server.exe next to sshd.exe', async () => {
    const out = await lan.run('PC1', 'where sftp-server');
    expect(out).toContain('C:\\Windows\\System32\\OpenSSH\\sftp-server.exe');
  });

  it('a Subsystem line that names a missing program makes the request fail, as on a real server', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp /usr/lib/openssh/missing-sftp-server', 'reload', ['Subsystem']);
    const out = await sftpBatch('PC11', 'alice', 'PC8', ['pwd']);
    await restore();
    expect(out).toContain('bash: line 1: /usr/lib/openssh/missing-sftp-server: No such file or directory');
    expect(out).toContain('Connection closed');
    expect(out).not.toContain('subsystem request failed');
  });

  it('a configuration with no Subsystem line has no sftp at all', async () => {
    const restore = await lan.editLinuxSshd('PC8', '', 'reload', ['Subsystem']);
    const out = await sftpBatch('PC2', 'alice', 'PC8', ['pwd']);
    await restore();
    expect(out).toContain('subsystem request failed on channel 0');
  });

  it('internal-sftp serves the same protocol without a program', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp internal-sftp', 'reload', ['Subsystem']);
    const out = await sftpBatch('PC11', 'alice', 'PC8', ['pwd']);
    await restore();
    expect(out).toContain('Remote working directory: /home/alice');
  });

  it('internal-sftp serves an account whose shell is nologin, the external program does not', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp internal-sftp', 'reload', ['Subsystem']);
    const out = await sftpBatch('PC11', 'carl', 'PC8', ['pwd']);
    await restore();
    expect(out).toContain('Remote working directory: /home/carl');
  });

  it('-R makes the session read-only: reading works, writing is refused', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp /usr/lib/openssh/sftp-server -R', 'reload', ['Subsystem']);
    await sudo('PC8', 'sh -c "echo ro > /home/bob/ro.txt; chown bob:bob /home/bob/ro.txt"');
    const out = await sftpBatch('PC11', 'bob', 'PC8', ['get ro.txt C:\\Users\\User\\ro.txt', '-put C:\\Users\\User\\ro.txt written.txt', 'mkdir newdir']);
    await restore();
    expect(out).toContain('Fetching /home/bob/ro.txt');
    expect(out).toContain('dest open "/home/bob/written.txt": Permission denied');
    expect(out).toContain('remote mkdir "/home/bob/newdir": Permission denied');
    expect(await lan.run('PC8', 'ls /home/bob')).not.toContain('written.txt');
  });

  it('-u sets the umask of the files it creates', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp /usr/lib/openssh/sftp-server -u 077', 'reload', ['Subsystem']);
    await sftpBatch('PC11', 'bob', 'PC8', ['put C:\\Users\\User\\keepname.txt masked.txt']);
    await restore();
    expect((await lan.run('PC8', 'stat -c %a /home/bob/masked.txt')).trim()).toBe('600');
  });

  it('-d chooses the directory a session starts in', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp /usr/lib/openssh/sftp-server -d /tmp', 'reload', ['Subsystem']);
    const out = await sftpBatch('PC11', 'bob', 'PC8', ['pwd']);
    await restore();
    expect(out).toContain('Remote working directory: /tmp');
  });

  it('-l INFO logs each opened and closed file in the authentication log', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Subsystem sftp /usr/lib/openssh/sftp-server -l INFO', 'reload', ['Subsystem']);
    await sftpBatch('PC11', 'bob', 'PC8', ['put C:\\Users\\User\\keepname.txt logged.txt']);
    await restore();
    const log = await sudo('PC8', 'grep sftp-server /var/log/auth.log');
    expect(log).toMatch(/sftp-server\[\d+\]: session opened for local user bob from \[192\.168\.50\.2\]/);
    expect(log).toMatch(/sftp-server\[\d+\]: open "\/home\/bob\/logged\.txt" flags WRITE,CREATE,TRUNCATE mode 0644/);
    expect(log).toMatch(/sftp-server\[\d+\]: close "\/home\/bob\/logged\.txt" bytes read 0 written \d+/);
  });

  it('ChrootDirectory with internal-sftp confines an account to its jail', async () => {
    await sudo('PC8', 'mkdir -p /srv/jail/dave/files');
    await sudo('PC8', 'sh -c "echo inside > /srv/jail/dave/files/in.txt; chown dave:dave /srv/jail/dave/files /srv/jail/dave/files/in.txt"');
    const restore = await lan.editLinuxSshd('PC8', 'Match User dave\n  ChrootDirectory /srv/jail/dave\n  ForceCommand internal-sftp');
    const out = await sftpBatch('PC11', 'dave', 'PC8', ['pwd', 'ls', 'cd /home', 'get /home/dave/sealed.txt C:\\Users\\User\\jailbreak.txt']);
    await restore();
    expect(out).toContain('Remote working directory: /');
    expect(out).toContain('files');
    expect(out).not.toContain('/srv/jail');
    expect(await lan.run('PC11', 'type C:\\Users\\User\\jailbreak.txt')).toContain('cannot find the file');
  });

  it('on Windows a Subsystem line naming a missing program makes the request fail', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'Subsystem sftp missing-sftp-server.exe', true, ['Subsystem']);
    const out = await sftpBatch('PC2', 'alice', 'PC10', ['pwd']);
    await restore();
    expect(out).toContain('subsystem request failed on channel 0');
  });

  it('on Windows internal-sftp serves the same protocol', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'Subsystem sftp internal-sftp', true, ['Subsystem']);
    const out = await sftpBatch('PC2', 'alice', 'PC10', ['pwd']);
    await restore();
    expect(out).toContain('Remote working directory: /C:/Users/alice');
  });
});
