/**
 * Laboratoire SSH_TP_LAN : le serveur `sshd` d'un poste Linux (OpenSSH 8.9p1 Ubuntu) et
 * d'un poste Windows (Win32-OpenSSH 8.6), interroge depuis l'autre systeme a travers
 * les routeurs, avec les quatre profils alice / bob / carl / dave.
 *
 * Les attentes viennent du code OpenSSH 8.9p1 : sshd.c (options, `re-exec requires
 * execution with an absolute path`), servconf.c (`dump_config`, `Bad configuration
 * option`, premiere valeur obtenue gagnante, Match), auth.c (`allowed_user` :
 * `not allowed because listed in DenyUsers`...), auth2.c (MaxAuthTries).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const sudo = (host: string, command: string): Promise<string> => lan.run(host, `sudo ${command}`, 'user\n');

const lastLine = (text: string): string => text.trim().split('\n').pop() ?? '';

const login = (client: string, user: string, server: string, command = 'hostname', extra = ''): Promise<string> =>
  lan.withPassword(client, `ssh ${NOCHECK} ${extra} ${user}@${lan.ip(server)} ${lan.quote(client, command)}`.replace(/ {2,}/g, ' '), user);

describe('sshd on Linux: the command line', () => {
  it('-t on a valid configuration is silent and succeeds', async () => {
    expect(lastLine((await sudo('PC8', '/usr/sbin/sshd -t; echo rc=$?')))).toBe('rc=0');
  });

  it('-t refuses a directive that does not exist, with the file and the line', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Foo bar', 'none');
    const out = await sudo('PC8', '/usr/sbin/sshd -t; echo rc=$?');
    await restore();
    expect(out).toMatch(/\/etc\/ssh\/sshd_config line \d+: Bad configuration option: Foo/);
    expect(out).toContain('/etc/ssh/sshd_config: terminating, 1 bad configuration options');
    expect(out).toContain('rc=255');
  });

  it('-t refuses a value that is not yes or no', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'PasswordAuthentication maybe', 'none');
    const out = await sudo('PC8', '/usr/sbin/sshd -t; echo rc=$?');
    await restore();
    expect(out).toMatch(/line \d+: Bad yes\/no argument: maybe/);
    expect(out).toContain('rc=255');
  });

  it('-t refuses a directive that has no argument', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'X11Forwarding', 'none');
    const out = await sudo('PC8', '/usr/sbin/sshd -t; echo rc=$?');
    await restore();
    expect(out).toMatch(/line \d+: missing yes\/no argument\./);
    expect(out).toContain('rc=255');
  });

  it('-t -f names a file that does not exist', async () => {
    const out = await sudo('PC8', '/usr/sbin/sshd -t -f /nonexistent; echo rc=$?');
    expect(out).toContain('/nonexistent: No such file or directory');
    expect(out).toContain('rc=1');
  });

  it('-t without privilege cannot read the host keys', async () => {
    const out = await lan.run('PC8', '/usr/sbin/sshd -t; echo rc=$?');
    expect(out).toContain('sshd: no hostkeys available -- exiting.');
    expect(out).toContain('rc=1');
  });

  it('-T prints the effective configuration, one lowercase keyword per line, in servconf.c order', async () => {
    const out = await sudo('PC8', '/usr/sbin/sshd -T');
    const keys = out.split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
    expect(keys.slice(0, 5)).toEqual(['port', 'addressfamily', 'listenaddress', 'listenaddress', 'usepam']);
    expect(out).toContain('port 22\n');
    expect(out).toContain('permitrootlogin without-password');
    expect(out).toContain('maxauthtries 6');
    expect(out).toContain('maxsessions 10');
    expect(out).toContain('logingracetime 120');
    expect(out).toContain('x11forwarding yes');
    expect(out).toContain('passwordauthentication yes');
    expect(out).toContain('pubkeyauthentication yes');
    expect(out).toContain('subsystem sftp /usr/lib/openssh/sftp-server');
    expect(out).toContain('hostkey /etc/ssh/ssh_host_ed25519_key');
    expect(out).toMatch(/\nciphers chacha20-poly1305@openssh.com,aes128-ctr,aes192-ctr,aes256-ctr,aes128-gcm@openssh.com,aes256-gcm@openssh.com\n/);
    expect(out).toMatch(/\nkexalgorithms curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,sntrup761x25519-sha512@openssh.com,/);
    expect(out.split('\n').filter(Boolean).length).toBeGreaterThan(80);
  });

  it('-T shows what a Match block changes for the connection described with -C', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Match User bob\n  PasswordAuthentication no\n  AllowTcpForwarding no', 'none');
    const forBob = await sudo('PC8', '/usr/sbin/sshd -T -C user=bob,host=client,addr=192.168.30.5');
    const forAlice = await sudo('PC8', '/usr/sbin/sshd -T -C user=alice,host=client,addr=192.168.30.5');
    await restore();
    expect(forBob).toContain('passwordauthentication no');
    expect(forBob).toContain('allowtcpforwarding no');
    expect(forAlice).toContain('passwordauthentication yes');
    expect(forAlice).toContain('allowtcpforwarding yes');
  });

  it('-T applies the first value obtained: a drop-in beats the main file', async () => {
    await sudo('PC8', 'sh -c "echo MaxAuthTries 2 > /etc/ssh/sshd_config.d/10-lab.conf"');
    const out = await sudo('PC8', '/usr/sbin/sshd -T');
    await sudo('PC8', 'rm -f /etc/ssh/sshd_config.d/10-lab.conf');
    expect(out).toContain('maxauthtries 2');
  });

  it('started by bare name, the daemon refuses to run', async () => {
    const out = await sudo('PC8', 'sshd -D; echo rc=$?');
    expect(out).toContain('sshd re-exec requires execution with an absolute path');
    expect(out).toContain('rc=255');
  });

  it('-D on port 22 while the service owns it cannot bind, and says so in the journal, not on the terminal', async () => {
    const out = await sudo('PC8', '/usr/sbin/sshd -D; echo rc=$?');
    const journal = await sudo('PC8', 'cat /var/log/auth.log');
    expect(out.trim()).toBe('rc=255');
    expect(journal).toMatch(/sshd\[\d+\]: error: Bind to port 22 on 0\.0\.0\.0 failed: Address already in use\./);
    expect(journal).toMatch(/sshd\[\d+\]: error: Bind to port 22 on :: failed: Address already in use\./);
    expect(journal).toMatch(/sshd\[\d+\]: fatal: Cannot bind any address\./);
  });

  it('-D -e writes the same messages on the terminal, without the syslog prefixes', async () => {
    const out = await sudo('PC8', '/usr/sbin/sshd -D -e; echo rc=$?');
    expect(out).toContain('Bind to port 22 on 0.0.0.0 failed: Address already in use.');
    expect(out).toContain('Bind to port 22 on :: failed: Address already in use.');
    expect(out).toContain('Cannot bind any address.');
    expect(out).not.toContain('error:');
    expect(out).toContain('rc=255');
  });

  it('-p starts a second daemon on its own port, reachable from the other system', async () => {
    await sudo('PC8', '/usr/sbin/sshd -p 2200');
    const out = await login('PC11', 'alice', 'PC8', 'hostname', '-p 2200');
    expect(lastLine(out)).toBe((await lan.run('PC8', 'hostname')).trim());
    const listening = await lan.run('PC8', 'ss -tln');
    expect(listening).toMatch(/LISTEN\s+\d+\s+\d+\s+0\.0\.0\.0:2200/);
    await sudo('PC8', 'pkill -f "sshd -p 2200"');
  });

  it('an unknown option prints the usage', async () => {
    const out = await sudo('PC8', '/usr/sbin/sshd -Z; echo rc=$?');
    expect(out).toContain("sshd: invalid option -- 'Z'");
    expect(out).toContain('usage: sshd [-46DdeGiqTtV]');
    expect(out).toContain('rc=1');
  });

  it('-h replaces the configured host keys: a missing file leaves none to load', async () => {
    const out = await sudo('PC8', '/usr/sbin/sshd -t -h /etc/ssh/missing_key; echo rc=$?');
    expect(out).toContain('sshd: no hostkeys available -- exiting.');
    expect(out).toContain('rc=1');
  });
});

describe('sshd on Linux: the service', () => {
  it('listens on 22 for IPv4 and IPv6 while running', async () => {
    const out = await lan.run('PC9', 'ss -tln');
    expect(out).toMatch(/LISTEN\s+\d+\s+\d+\s+0\.0\.0\.0:22\s/);
    expect(out).toMatch(/LISTEN\s+\d+\s+\d+\s+\[::\]:22\s/);
  });

  it('systemctl reports the unit and its main process', async () => {
    const out = (await lan.run('PC9', 'systemctl status ssh')).replace(/\u001b\[[0-9;]*m/g, '');
    expect(out).toContain('ssh.service - OpenBSD Secure Shell server');
    expect(out).toContain('Active: active (running)');
    expect(out).toContain('/usr/sbin/sshd -D');
  });

  it('stop closes the port, start reopens it', async () => {
    await sudo('PC9', 'systemctl stop ssh');
    expect(await lan.run('PC9', 'ss -tln')).not.toMatch(/:22\s/);
    expect(await login('PC11', 'alice', 'PC9')).toContain('Connection refused');
    await sudo('PC9', 'systemctl start ssh');
    expect(lastLine((await login('PC11', 'alice', 'PC9')))).toBe((await lan.run('PC9', 'hostname')).trim());
  });

  it('the journal records the listener each time the service starts', async () => {
    await sudo('PC9', 'systemctl restart ssh');
    const out = await sudo('PC9', 'journalctl -u ssh --no-pager');
    expect(out).toContain('Server listening on 0.0.0.0 port 22.');
    expect(out).toContain('Server listening on :: port 22.');
  });

  it('a configuration change applies on reload and not before', async () => {
    const restore = await lan.editLinuxSshd('PC9', 'DenyUsers bob', 'none');
    expect(lastLine((await login('PC11', 'bob', 'PC9')))).toBe((await lan.run('PC9', 'hostname')).trim());
    await sudo('PC9', 'systemctl reload ssh');
    expect(await login('PC11', 'bob', 'PC9')).toContain('Permission denied');
    await restore();
  });

  it('a broken configuration makes reload fail and keeps the old policy', async () => {
    const restore = await lan.editLinuxSshd('PC9', 'Foo bar', 'none');
    const out = await sudo('PC9', 'systemctl reload ssh');
    expect(out).toMatch(/Job for ssh.service failed|Bad configuration option/);
    expect(lastLine((await login('PC11', 'bob', 'PC9')))).toBe((await lan.run('PC9', 'hostname')).trim());
    await restore();
  });
});

describe('sshd on Linux: who may log in', () => {
  it('DenyUsers refuses the named account, logs why, and still lets the others in', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'DenyUsers bob');
    const bob = await login('PC11', 'bob', 'PC8');
    const alice = await login('PC11', 'alice', 'PC8');
    const journal = await sudo('PC8', 'grep "not allowed" /var/log/auth.log');
    await restore();
    expect(bob).toContain(`bob@${lan.ip('PC8')}: Permission denied (publickey,password).`);
    expect(lastLine(alice)).toBe((await lan.run('PC8', 'hostname')).trim());
    expect(journal).toContain(`User bob from ${lan.ip('PC11')} not allowed because listed in DenyUsers`);
  });

  it('AllowUsers admits only the listed accounts', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'AllowUsers alice dave');
    const results = {
      alice: await login('PC11', 'alice', 'PC8'),
      dave: await login('PC11', 'dave', 'PC8'),
      bob: await login('PC11', 'bob', 'PC8'),
    };
    const journal = await sudo('PC8', 'grep "not allowed" /var/log/auth.log');
    await restore();
    const hostname = (await lan.run('PC8', 'hostname')).trim();
    expect(lastLine(results.alice)).toBe(hostname);
    expect(lastLine(results.dave)).toBe(hostname);
    expect(results.bob).toContain('Permission denied');
    expect(journal).toContain('User bob from');
    expect(journal).toContain('not allowed because not listed in AllowUsers');
  });

  it('AllowUsers user@address restricts an account to one network, whatever the OS of the client', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'AllowUsers alice@192.168.30.* bob');
    const fromHq = await login('PC2', 'alice', 'PC8');
    const fromHqWindows = await login('PC1', 'alice', 'PC8');
    const fromAkwa = await login('PC11', 'alice', 'PC8');
    const bobFromAkwa = await login('PC11', 'bob', 'PC8');
    await restore();
    const hostname = (await lan.run('PC8', 'hostname')).trim();
    expect(lastLine(fromHq)).toBe(hostname);
    expect(lastLine(fromHqWindows)).toBe(hostname);
    expect(fromAkwa).toContain('Permission denied');
    expect(lastLine(bobFromAkwa)).toBe(hostname);
  });

  it('AllowGroups lets the sudo group in and keeps the plain users out', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'AllowGroups sudo');
    const alice = await login('PC11', 'alice', 'PC8');
    const bob = await login('PC11', 'bob', 'PC8');
    const journal = await sudo('PC8', 'grep "not allowed" /var/log/auth.log');
    await restore();
    expect(lastLine(alice)).toBe((await lan.run('PC8', 'hostname')).trim());
    expect(bob).toContain('Permission denied');
    expect(journal).toContain("not allowed because none of user's groups are listed in AllowGroups");
  });

  it('DenyGroups refuses a whole group', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'DenyGroups sudo');
    const alice = await login('PC11', 'alice', 'PC8');
    const bob = await login('PC11', 'bob', 'PC8');
    await restore();
    expect(alice).toContain('Permission denied');
    expect(lastLine(bob)).toBe((await lan.run('PC8', 'hostname')).trim());
  });

  it('PermitRootLogin keeps its default: root cannot enter with a password', async () => {
    const out = await lan.run('PC11', `ssh ${NOCHECK} root@${lan.ip('PC8')} hostname`, 'root\n');
    expect(out).toContain('Permission denied');
  });

  it('PasswordAuthentication no leaves only the public key method', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'PasswordAuthentication no');
    const out = await login('PC11', 'alice', 'PC8');
    await restore();
    expect(out).toContain(`alice@${lan.ip('PC8')}: Permission denied (publickey).`);
  });

  it('a drop-in file in sshd_config.d is read, and wins over the main file', async () => {
    await sudo('PC8', 'sh -c "echo PasswordAuthentication no > /etc/ssh/sshd_config.d/20-lab.conf"');
    await sudo('PC8', 'systemctl reload ssh');
    const out = await login('PC11', 'alice', 'PC8');
    await sudo('PC8', 'rm -f /etc/ssh/sshd_config.d/20-lab.conf');
    await sudo('PC8', 'systemctl reload ssh');
    expect(out).toContain('Permission denied (publickey).');
  });

  it('Match User applies to one account only', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Match User bob\n  PasswordAuthentication no');
    const bob = await login('PC11', 'bob', 'PC8');
    const alice = await login('PC11', 'alice', 'PC8');
    await restore();
    expect(bob).toContain('Permission denied (publickey).');
    expect(lastLine(alice)).toBe((await lan.run('PC8', 'hostname')).trim());
  });

  it('Match Address applies to one network only', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Match Address 192.168.50.0/24\n  PasswordAuthentication no');
    const fromAkwa = await login('PC11', 'alice', 'PC8');
    const fromHq = await login('PC2', 'alice', 'PC8');
    await restore();
    expect(fromAkwa).toContain('Permission denied (publickey).');
    expect(lastLine(fromHq)).toBe((await lan.run('PC8', 'hostname')).trim());
  });

  it('ForceCommand replaces whatever the client asked for', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'Match User dave\n  ForceCommand echo restricted-by-admin');
    const dave = await login('PC11', 'dave', 'PC8', 'hostname');
    const alice = await login('PC11', 'alice', 'PC8', 'hostname');
    await restore();
    expect(lastLine(dave)).toBe('restricted-by-admin');
    expect(lastLine(alice)).toBe((await lan.run('PC8', 'hostname')).trim());
  });

  it('MaxAuthTries closes the connection after that many refusals', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'MaxAuthTries 1');
    const out = await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} bob@${lan.ip('PC8')} hostname`);
    const journal = await sudo('PC8', 'grep -i "maximum authentication attempts exceeded" /var/log/auth.log');
    await restore();
    expect(out).toMatch(/Too many authentication failures|Permission denied/);
    expect(journal).toContain(`maximum authentication attempts exceeded for bob from ${lan.ip('PC2')} port`);
  });

  it('a Banner is shown to the client before authentication, on Windows and on Linux clients', async () => {
    await sudo('PC8', 'sh -c "echo AUTHORISED-USE-ONLY > /etc/ssh/lab-banner"');
    const restore = await lan.editLinuxSshd('PC8', 'Banner /etc/ssh/lab-banner');
    const fromWindows = await lan.run('PC11', `ssh ${NOCHECK} alice@${lan.ip('PC8')} hostname`, 'alice\n');
    const fromLinux = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC8')} hostname`);
    await restore();
    expect(fromWindows).toContain('AUTHORISED-USE-ONLY');
    expect(fromLinux).toContain('AUTHORISED-USE-ONLY');
  });

  it('AllowTcpForwarding no refuses a stdio forward, whoever the client is', async () => {
    const restore = await lan.editLinuxSshd('PC8', 'AllowTcpForwarding no');
    const out = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} -W 127.0.0.1:22 alice@${lan.ip('PC8')}`);
    await restore();
    expect(out).toContain('channel 0: open failed: administratively prohibited: open failed');
    expect(out).toContain('stdio forwarding failed');
  });

  it('six wrong passwords do not ban the client while fail2ban is not running: sshd keeps no blacklist', async () => {
    expect(await sudo('PC9', 'systemctl is-active fail2ban')).toContain('inactive');
    for (let i = 0; i < 6; i += 1) await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} bob@${lan.ip('PC9')} hostname`);
    const out = await lan.withPassword('PC2', `ssh ${NOCHECK} bob@${lan.ip('PC9')} hostname`, 'bob');
    expect(lastLine(out)).toBe((await lan.run('PC9', 'hostname')).trim());
    expect(out).not.toContain('Refusing connection');
  });

  it('with fail2ban running, the fifth failure is banned by iptables, not by sshd', async () => {
    await sudo('PC9', 'systemctl restart fail2ban');
    for (let i = 0; i < 5; i += 1) await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} bob@${lan.ip('PC9')} hostname`);
    const refused = await lan.run('PC2', `sshpass -p bob ssh ${NOCHECK} bob@${lan.ip('PC9')} hostname`);
    const rules = await sudo('PC9', 'iptables -L f2b-sshd -n');
    const log = await sudo('PC9', 'cat /var/log/fail2ban.log');
    const status = await sudo('PC9', 'fail2ban-client status sshd');
    await sudo('PC9', `fail2ban-client set sshd unbanip ${lan.ip('PC2')}`);
    const after = await lan.run('PC2', `sshpass -p bob ssh ${NOCHECK} bob@${lan.ip('PC9')} hostname`);
    await sudo('PC9', 'systemctl stop fail2ban');
    expect(refused).toContain('Connection refused');
    expect(rules).toMatch(new RegExp(`REJECT\\s+all\\s+--\\s+${lan.ip('PC2').replace(/\./g, '\\.')}`));
    expect(log).toContain(`[sshd] Ban ${lan.ip('PC2')}`);
    expect(status).toContain(lan.ip('PC2'));
    expect(lastLine(after)).toBe((await lan.run('PC9', 'hostname')).trim());
  });
});

describe('sshd on Linux: the journal', () => {
  it('records the connection, the method, the session and its end', async () => {
    await login('PC11', 'alice', 'PC9');
    const out = await sudo('PC9', 'cat /var/log/auth.log');
    expect(out).toMatch(new RegExp(`sshd\\[\\d+\\]: Accepted password for alice from ${lan.ip('PC11').replace(/\./g, '\\.')} port \\d+ ssh2`));
    expect(out).toContain('pam_unix(sshd:session): session opened for user alice(uid=1001)');
    expect(out).toContain('pam_unix(sshd:session): session closed for user alice');
  });

  it('records a refused password with the account and the address', async () => {
    await lan.run('PC11', `ssh ${NOCHECK} bob@${lan.ip('PC9')} hostname`, 'bad\nbad\nbad\n');
    const out = await sudo('PC9', 'cat /var/log/auth.log');
    expect(out).toMatch(new RegExp(`Failed password for bob from ${lan.ip('PC11').replace(/\./g, '\\.')} port \\d+ ssh2`));
  });

  it('records the key used by a public-key login, by its fingerprint', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -f /home/user/.ssh/id_lab');
    await sudo('PC9', 'mkdir -p /home/bob/.ssh');
    const pub = (await lan.run('PC2', 'cat /home/user/.ssh/id_lab.pub')).trim();
    await sudo('PC9', `sh -c "echo '${pub}' >> /home/bob/.ssh/authorized_keys"`);
    await sudo('PC9', 'chown -R bob:bob /home/bob/.ssh');
    await sudo('PC9', 'chmod 700 /home/bob/.ssh');
    await sudo('PC9', 'chmod 600 /home/bob/.ssh/authorized_keys');
    const out = await lan.run('PC2', `ssh ${NOCHECK} -i /home/user/.ssh/id_lab bob@${lan.ip('PC9')} hostname`);
    expect(lastLine(out)).toBe((await lan.run('PC9', 'hostname')).trim());
    const journal = await sudo('PC9', 'grep "Accepted publickey" /var/log/auth.log');
    expect(journal).toMatch(/Accepted publickey for bob from 192\.168\.30\.5 port \d+ ssh2: ED25519 SHA256:/);
  });
});

describe('sshd on Windows: the service', () => {
  it('runs under the service manager and listens on 22', async () => {
    expect(await lan.run('PC10', 'sc query sshd')).toContain('RUNNING');
    expect(await lan.run('PC10', 'netstat -an')).toMatch(/TCP\s+0\.0\.0\.0:22\s+0\.0\.0\.0:0\s+LISTENING/);
  });

  it('is a real program in the OpenSSH folder, as are its sftp-server and its tools', async () => {
    const out = await lan.run('PC10', 'dir C:\\Windows\\System32\\OpenSSH');
    for (const program of ['sshd.exe', 'sftp-server.exe', 'ssh.exe', 'scp.exe', 'sftp.exe', 'ssh-keygen.exe', 'ssh-keyscan.exe', 'ssh-agent.exe', 'ssh-add.exe']) {
      expect(out).toContain(program);
    }
    expect(out).not.toContain('ssh-copy-id');
  });

  it('keeps its configuration and host keys under ProgramData', async () => {
    const out = await lan.run('PC10', 'dir C:\\ProgramData\\ssh');
    expect(out).toContain('sshd_config');
    expect(out).toContain('ssh_host_ed25519_key');
    expect(out).toContain('ssh_host_ed25519_key.pub');
  });

  it('its default sshd_config sends administrators to administrators_authorized_keys', async () => {
    const out = await lan.run('PC10', 'type C:\\ProgramData\\ssh\\sshd_config');
    expect(out).toMatch(/Match Group administrators\s+AuthorizedKeysFile __PROGRAMDATA__\/ssh\/administrators_authorized_keys/);
  });

  it('the private host key is readable only by SYSTEM and the administrators', async () => {
    const out = await lan.run('PC10', 'icacls C:\\ProgramData\\ssh\\ssh_host_ed25519_key');
    expect(out).toContain('NT AUTHORITY\\SYSTEM:(F)');
    expect(out).toContain('BUILTIN\\Administrators:(F)');
    expect(out).not.toContain('BUILTIN\\Users');
  });

  it('net stop closes the port and net start reopens it', async () => {
    await lan.asWindowsAdministrator('PC10', ['net stop sshd']);
    expect(await lan.run('PC10', 'sc query sshd')).toContain('STOPPED');
    expect(await login('PC2', 'alice', 'PC10')).toContain('Connection refused');
    await lan.asWindowsAdministrator('PC10', ['net start sshd']);
    expect(lastLine((await login('PC2', 'alice', 'PC10')))).toBe('PC10');
  });

  it('a standard user cannot stop the service', async () => {
    const out = await lan.run('PC10', 'net stop sshd');
    expect(out).toMatch(/System error 5 has occurred|Access is denied/);
    expect(await lan.run('PC10', 'sc query sshd')).toContain('RUNNING');
  });

  it('sshd -t validates the file as an administrator, silently when it is fine', async () => {
    const out = await lan.asWindowsAdministrator('PC10', ['sshd -t']);
    expect(lastLine(out)).toBe('');
  });

  it('sshd -t names the line of a bad directive', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'Foo bar', false);
    const out = await lan.asWindowsAdministrator('PC10', ['sshd -t']);
    await restore();
    expect(out).toMatch(/line \d+: Bad configuration option: Foo/);
  });

  it('sshd -T dumps the effective configuration with Windows paths', async () => {
    const out = await lan.asWindowsAdministrator('PC10', ['sshd -T']);
    expect(out).toContain('port 22');
    expect(out).toContain('subsystem sftp sftp-server.exe');
    expect(out).toMatch(/hostkey __PROGRAMDATA__\/ssh\/ssh_host_ed25519_key|hostkey C:\/ProgramData\/ssh\/ssh_host_ed25519_key/i);
  });
});

describe('sshd on Windows: who may log in', () => {
  it('DenyUsers refuses the named account only', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'DenyUsers bob');
    const bob = await login('PC2', 'bob', 'PC10');
    const alice = await login('PC2', 'alice', 'PC10');
    await restore();
    expect(bob).toMatch(new RegExp(`bob@${lan.ip('PC10').replace(/\\./g, '\\\\.')}: Permission denied \\(publickey,password`));
    expect(lastLine(alice)).toBe('PC10');
  });

  it('AllowUsers admits the listed accounts only', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'AllowUsers alice');
    const alice = await login('PC11', 'alice', 'PC10');
    const bob = await login('PC11', 'bob', 'PC10');
    await restore();
    expect(lastLine(alice)).toBe('PC10');
    expect(bob).toContain('Permission denied');
  });

  it('AllowGroups names a local group: administrators in, plain users out', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'AllowGroups administrators');
    const alice = await login('PC2', 'alice', 'PC10');
    const bob = await login('PC2', 'bob', 'PC10');
    await restore();
    expect(lastLine(alice)).toBe('PC10');
    expect(bob).toContain('Permission denied');
  });

  it('PasswordAuthentication no leaves only the public key method', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'PasswordAuthentication no');
    const out = await login('PC2', 'alice', 'PC10');
    await restore();
    expect(out).toContain(`alice@${lan.ip('PC10')}: Permission denied (publickey).`);
  });

  it('a configuration change applies on service restart, not on edit', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'DenyUsers bob', false);
    expect(lastLine((await login('PC2', 'bob', 'PC10')))).toBe('PC10');
    await lan.asWindowsAdministrator('PC10', ['net stop sshd', 'net start sshd']);
    expect(await login('PC2', 'bob', 'PC10')).toContain('Permission denied');
    await restore();
  });

  it('Port moves the listener: the old port is refused, the new one answers', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'Port 2022');
    const moved = await login('PC2', 'alice', 'PC10', 'hostname', '-p 2022');
    const old = await login('PC2', 'alice', 'PC10');
    await restore();
    expect(lastLine(moved)).toBe('PC10');
    expect(old).toContain('Connection refused');
  });

  it('ForceCommand replaces what the client asked for', async () => {
    const restore = await lan.editWindowsSshd('PC10', 'Match User dave\n  ForceCommand echo restricted-by-admin');
    const dave = await login('PC2', 'dave', 'PC10', 'hostname');
    await restore();
    expect(lastLine(dave)).toBe('restricted-by-admin');
  });

  it('a Banner is shown to a Linux client before authentication', async () => {
    await lan.asWindowsAdministrator('PC10', ['echo AUTHORISED-USE-ONLY> C:\\ProgramData\\ssh\\banner.txt']);
    const restore = await lan.editWindowsSshd('PC10', 'Banner C:\\ProgramData\\ssh\\banner.txt');
    const out = await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC10')} hostname`);
    await restore();
    expect(out).toContain('AUTHORISED-USE-ONLY');
  });

  it('a refused attempt and a good login both reach the OpenSSH operational log', async () => {
    await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} bob@${lan.ip('PC10')} hostname`);
    await login('PC2', 'alice', 'PC10');
    const out = await lan.asWindowsAdministrator('PC10', ['powershell -Command "Get-WinEvent -LogName OpenSSH/Operational | Select-Object -ExpandProperty Message"']);
    expect(out).toMatch(new RegExp(`sshd: Failed password for bob from ${lan.ip('PC2').replace(/\./g, '\\.')} port \\d+ ssh2`));
    expect(out).toMatch(new RegExp(`sshd: Accepted password for alice from ${lan.ip('PC2').replace(/\./g, '\\.')} port \\d+ ssh2`));
  });

  it('six wrong passwords from one client do not ban it', async () => {
    for (let i = 0; i < 6; i += 1) await lan.run('PC2', `sshpass -p wrong ssh ${NOCHECK} bob@${lan.ip('PC10')} hostname`);
    const out = await login('PC2', 'bob', 'PC10');
    expect(lastLine(out)).toBe('PC10');
  });
});
