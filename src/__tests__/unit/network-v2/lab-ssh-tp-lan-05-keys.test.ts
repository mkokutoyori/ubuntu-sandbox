/**
 * Laboratoire SSH_TP_LAN : `ssh-keygen` (generation et gestion), `ssh-keygen -F`,
 * `ssh-keygen -R` et `ssh-keyscan`, sur des postes Linux et Windows de sites
 * differents. Les cles produites sur un systeme servent a se connecter sur l'autre
 * (section « une cle ... ») et les cles d'hote que l'on collecte sont comparees a
 * celles que le serveur detient reellement.
 *
 * Attentes tirees de ssh-keygen.c et ssh-keyscan.c (8.9p1) : textes de dialogue,
 * `usage`, options -l -y -p -c -e -r -F -R -H -A, types par defaut de ssh-keyscan
 * (rsa, ecdsa, ed25519 + les deux types FIDO), une connexion et une banniere par type.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SshTpLan, NOCHECK } from './sshTpLanLab';

let lan: SshTpLan;

beforeAll(async () => { lan = await SshTpLan.build(); }, 180_000);
afterAll(() => { SshTpLan.dispose(); });

const CLIENTS = ['PC2', 'PC1', 'PC11', 'PC9'];
const dir = (host: string): string => (lan.platform(host) === 'linux' ? '/tmp' : 'C:\\Users\\User');
const at = (host: string, name: string): string => `${dir(host)}${lan.platform(host) === 'linux' ? '/' : '\\'}${name}`;
const read = (host: string, path: string): Promise<string> =>
  lan.run(host, lan.platform(host) === 'linux' ? `cat ${path}` : `type ${path}`);
const homeSsh = (host: string): string => (lan.platform(host) === 'linux' ? '/home/user/.ssh' : 'C:\\Users\\User\\.ssh');
const sudo = (host: string, command: string): Promise<string> => lan.run(host, `sudo ${command}`, 'user\n');

describe.each(CLIENTS)('ssh-keygen on %s: generating a pair', (client) => {
  it('-t ed25519 writes the pair, shows the fingerprint and the randomart', async () => {
    const out = await lan.run(client, `ssh-keygen -t ed25519 -N "" -f ${at(client, 'gen-ed')}`);
    expect(out).toContain('Generating public/private ed25519 key pair.');
    expect(out).toContain(`Your identification has been saved in ${at(client, 'gen-ed')}`);
    expect(out).toContain(`Your public key has been saved in ${at(client, 'gen-ed')}.pub`);
    expect(out).toContain('The key fingerprint is:');
    expect(out).toMatch(/SHA256:[A-Za-z0-9+/]{43} \S+@\S+/);
    expect(out).toContain("The key's randomart image is:");
    expect(out).toContain('+--[ED25519 256]--+');
    expect(out).toContain('+----[SHA256]-----+');
  });

  it('the private key is an OpenSSH key and the public key is one line of type, blob and comment', async () => {
    await lan.run(client, `ssh-keygen -q -t ed25519 -N "" -C lab-comment -f ${at(client, 'fmt-ed')}`);
    const priv = await read(client, at(client, 'fmt-ed'));
    expect(priv.trim().split(/\r?\n/)[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(priv.trim().split(/\r?\n/).pop()).toBe('-----END OPENSSH PRIVATE KEY-----');
    const pub = (await read(client, `${at(client, 'fmt-ed')}.pub`)).trim();
    expect(pub).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA[A-Za-z0-9+/]+ lab-comment$/);
  });

  it('the default comment is user@host', async () => {
    await lan.run(client, `ssh-keygen -q -t ed25519 -N "" -f ${at(client, 'cmt-ed')}`);
    const pub = (await read(client, `${at(client, 'cmt-ed')}.pub`)).trim();
    const hostname = (await lan.run(client, 'hostname')).trim();
    expect(pub.endsWith(`@${hostname}`)).toBe(true);
  });

  it('-q prints nothing', async () => {
    const out = await lan.run(client, `ssh-keygen -q -t ed25519 -N "" -f ${at(client, 'quiet-ed')}`);
    expect(out.trim()).toBe('');
  });

  it('-t rsa -b 2048 makes a 2048-bit RSA key', async () => {
    const out = await lan.run(client, `ssh-keygen -t rsa -b 2048 -N "" -f ${at(client, 'gen-rsa')}`);
    expect(out).toContain('Generating public/private rsa key pair.');
    expect(out).toContain('+---[RSA 2048]----+');
    const fp = await lan.run(client, `ssh-keygen -l -f ${at(client, 'gen-rsa')}.pub`);
    expect(fp).toMatch(/^2048 SHA256:\S+ \S+@\S+ \(RSA\)/);
    expect((await read(client, `${at(client, 'gen-rsa')}.pub`)).startsWith('ssh-rsa AAAAB3NzaC1yc2E')).toBe(true);
  });

  it.each([256, 384, 521])('-t ecdsa -b %i makes an ECDSA key of that size', async (bits) => {
    await lan.run(client, `ssh-keygen -q -t ecdsa -b ${bits} -N "" -f ${at(client, `gen-ec${bits}`)}`);
    const fp = await lan.run(client, `ssh-keygen -l -f ${at(client, `gen-ec${bits}`)}.pub`);
    expect(fp).toMatch(new RegExp(`^${bits} SHA256:\\S+ \\S+@\\S+ \\(ECDSA\\)`));
    expect((await read(client, `${at(client, `gen-ec${bits}`)}.pub`)).startsWith(`ecdsa-sha2-nistp${bits} `)).toBe(true);
  });

  it('refuses an unknown key type, a bad length and an RSA key that is too small', async () => {
    expect(await lan.run(client, 'ssh-keygen -t nonsense')).toContain('unknown key type nonsense');
    expect(await lan.run(client, `ssh-keygen -t ecdsa -b 100 -N "" -f ${at(client, 'bad-ec')}`)).toContain('Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits');
    expect(await lan.run(client, `ssh-keygen -t rsa -b 512 -N "" -f ${at(client, 'bad-rsa')}`)).toContain('Invalid RSA key length: minimum is 1024 bits');
  });

  it('asks before overwriting, and keeps the key on n', async () => {
    await lan.run(client, `ssh-keygen -q -t ed25519 -N "" -f ${at(client, 'over-ed')}`);
    const before = await read(client, `${at(client, 'over-ed')}.pub`);
    const out = await lan.run(client, `ssh-keygen -t ed25519 -N "" -f ${at(client, 'over-ed')}`, 'n\n');
    expect(out).toContain(`${at(client, 'over-ed')} already exists.`);
    expect(out).toContain('Overwrite (y/n)?');
    expect(await read(client, `${at(client, 'over-ed')}.pub`)).toBe(before);
  });

  it('replaces the key on y', async () => {
    await lan.run(client, `ssh-keygen -q -t ed25519 -N "" -f ${at(client, 'yes-ed')}`);
    const before = await read(client, `${at(client, 'yes-ed')}.pub`);
    await lan.run(client, `ssh-keygen -q -t ed25519 -N "" -f ${at(client, 'yes-ed')}`, 'y\n');
    expect(await read(client, `${at(client, 'yes-ed')}.pub`)).not.toBe(before);
  });

  it('with no -f it asks for the file, offers the default and creates the .ssh folder', async () => {
    const out = await lan.run(client, 'ssh-keygen -t ed25519 -N ""', '\n');
    const expected = lan.platform(client) === 'linux' ? '/home/user/.ssh/id_ed25519' : 'C:\\Users\\User/.ssh/id_ed25519';
    expect(out).toContain(`Enter file in which to save the key (${expected})`);
    expect(out).toContain('Your identification has been saved in');
    expect(await lan.run(client, lan.platform(client) === 'linux' ? 'ls /home/user/.ssh' : 'dir /b C:\\Users\\User\\.ssh')).toContain('id_ed25519.pub');
  });

  it('with no passphrase on the command line it asks twice, and refuses two different answers', async () => {
    const out = await lan.run(client, `ssh-keygen -t ed25519 -f ${at(client, 'ask-ed')}`, 'one\ntwo\n');
    expect(out).toContain('Enter passphrase (empty for no passphrase):');
    expect(out).toContain('Enter same passphrase again:');
    expect(out).toContain('Passphrases do not match.  Try again.');
  });
});

describe('ssh-keygen: reading and converting keys', () => {
  it('-l prints bits, hash, comment and type; -E md5 changes the hash; -lv adds the randomart', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N "" -C reader -f /tmp/read-ed');
    expect((await lan.run('PC2', 'ssh-keygen -l -f /tmp/read-ed.pub')).trim()).toMatch(/^256 SHA256:[A-Za-z0-9+/]{43} reader \(ED25519\)$/);
    expect((await lan.run('PC2', 'ssh-keygen -l -E md5 -f /tmp/read-ed.pub')).trim()).toMatch(/^256 MD5:([0-9a-f]{2}:){15}[0-9a-f]{2} reader \(ED25519\)$/);
    expect(await lan.run('PC2', 'ssh-keygen -lv -f /tmp/read-ed.pub')).toContain('+--[ED25519 256]--+');
  });

  it('-l works from the private key as well, and from a Windows key on the Linux side', async () => {
    await lan.run('PC1', 'ssh-keygen -q -t ed25519 -N "" -C from-windows -f C:\\Users\\User\\xfer-ed');
    const winPub = (await lan.run('PC1', 'type C:\\Users\\User\\xfer-ed.pub')).trim();
    await lan.run('PC2', `printf '%s\\n' '${winPub}' > /tmp/xfer-ed.pub`);
    const onLinux = (await lan.run('PC2', 'ssh-keygen -l -f /tmp/xfer-ed.pub')).trim();
    const onWindows = (await lan.run('PC1', 'ssh-keygen -l -f C:\\Users\\User\\xfer-ed')).trim();
    expect(onLinux).toBe(onWindows);
  });

  it('-y derives the public key from the private key', async () => {
    const out = (await lan.run('PC2', 'ssh-keygen -y -f /tmp/read-ed')).trim();
    expect(out).toBe((await lan.run('PC2', 'cat /tmp/read-ed.pub')).trim());
  });

  it('-y on a missing file fails', async () => {
    expect(await lan.run('PC2', 'ssh-keygen -y -f /tmp/nope-key')).toContain('/tmp/nope-key: No such file or directory');
  });

  it('-e prints the public key in RFC 4716 format', async () => {
    const out = await lan.run('PC2', 'ssh-keygen -e -f /tmp/read-ed.pub');
    expect(out).toContain('---- BEGIN SSH2 PUBLIC KEY ----');
    expect(out).toContain('Comment: "256-bit ED25519, converted by user@');
    expect(out).toContain('---- END SSH2 PUBLIC KEY ----');
  });

  it('-i imports what -e exported, back to the same key', async () => {
    await lan.run('PC2', 'ssh-keygen -e -f /tmp/read-ed.pub > /tmp/read-ed.rfc4716');
    const out = (await lan.run('PC2', 'ssh-keygen -i -f /tmp/read-ed.rfc4716')).trim();
    expect(out.split(' ').slice(0, 2)).toEqual((await lan.run('PC2', 'cat /tmp/read-ed.pub')).trim().split(' ').slice(0, 2));
  });

  it('-r prints the SSHFP records of a key', async () => {
    const out = await lan.run('PC2', 'ssh-keygen -r host.example.com -f /tmp/read-ed.pub');
    expect(out).toMatch(/^host\.example\.com IN SSHFP 4 1 [0-9a-f]{40}$/m);
    expect(out).toMatch(/^host\.example\.com IN SSHFP 4 2 [0-9a-f]{64}$/m);
  });

  it('prints its usage for a combination it does not know', async () => {
    const out = await lan.run('PC2', 'ssh-keygen -Z');
    expect(out).toContain('usage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]');
  });
});

describe('ssh-keygen: passphrases, on both systems', () => {
  it.each(['PC2', 'PC1'])('%s: a key generated with -N is encrypted on disk and asked for on use', async (client) => {
    await lan.run(client, `ssh-keygen -q -t ed25519 -N hunter2 -f ${at(client, 'sec-ed')}`);
    const priv = await read(client, at(client, 'sec-ed'));
    expect(priv).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(Buffer.from(priv.replace(/-----[^-]+-----|\s/g, ''), 'base64').toString('latin1')).toMatch(/aes256-ctr[\s\S]*bcrypt/);
    expect((await lan.run(client, `ssh-keygen -y -f ${at(client, 'sec-ed')}`, 'hunter2\n'))).toContain('ssh-ed25519 AAAA');
    const wrong = await lan.run(client, `ssh-keygen -y -f ${at(client, 'sec-ed')}`, 'wrong\n');
    expect(wrong).toContain('Load key');
    expect(wrong).toContain('incorrect passphrase supplied to decrypt private key');
  });

  it('-p changes the passphrase of a key given -P and -N', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N old -f /tmp/chg-ed');
    const out = await lan.run('PC2', 'ssh-keygen -p -f /tmp/chg-ed -P old -N new');
    expect(out).toContain('Your identification has been saved with the new passphrase.');
    expect(await lan.run('PC2', 'ssh-keygen -y -f /tmp/chg-ed', 'new\n')).toContain('ssh-ed25519 AAAA');
    expect(await lan.run('PC2', 'ssh-keygen -y -f /tmp/chg-ed', 'old\n')).toContain('incorrect passphrase');
  });

  it('-p asks for the old and the new passphrase when they are not given', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N first -f /tmp/askpw-ed');
    const out = await lan.run('PC2', 'ssh-keygen -p -f /tmp/askpw-ed', 'first\nsecond\nsecond\n');
    expect(out).toContain("Enter old passphrase:");
    expect(out).toContain('Enter new passphrase (empty for no passphrase):');
    expect(out).toContain('Enter same passphrase again:');
    expect(out).toContain('Your identification has been saved with the new passphrase.');
  });

  it('-p with an empty new passphrase removes the protection', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N pw -f /tmp/drop-ed');
    await lan.run('PC2', 'ssh-keygen -p -f /tmp/drop-ed -P pw -N ""');
    expect(await lan.run('PC2', 'ssh-keygen -y -f /tmp/drop-ed')).toContain('ssh-ed25519 AAAA');
  });

  it('-c changes the comment, asking for the passphrase of an encrypted key', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N pw -C before -f /tmp/cmt2-ed');
    const out = await lan.run('PC2', 'ssh-keygen -c -f /tmp/cmt2-ed -P pw -C after');
    expect(out).toContain("Comment 'after' applied");
    expect(await lan.run('PC2', 'cat /tmp/cmt2-ed.pub')).toContain(' after');
  });

  it('the private key written for a passphrase keeps mode 600 on Linux', async () => {
    await lan.run('PC2', 'ssh-keygen -q -t ed25519 -N pw -f /tmp/mode-ed');
    expect((await lan.run('PC2', 'stat -c %a /tmp/mode-ed /tmp/mode-ed.pub')).trim().split(/\s+/)).toEqual(['600', '644']);
  });
});

describe('ssh-keygen -A: the host keys of a machine', () => {
  it('a Linux machine owns the three host key types of an Ubuntu install', async () => {
    const out = await sudo('PC6', 'ls /etc/ssh');
    for (const type of ['rsa', 'ecdsa', 'ed25519']) {
      expect(out).toContain(`ssh_host_${type}_key`);
      expect(out).toContain(`ssh_host_${type}_key.pub`);
    }
  });

  it('-A generates the ones that are missing and says which', async () => {
    await sudo('PC8', 'rm -f /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub');
    const out = await sudo('PC8', 'ssh-keygen -A');
    expect(out).toContain('ssh-keygen: generating new host keys: ECDSA');
    expect(await sudo('PC8', 'ls /etc/ssh')).toContain('ssh_host_ecdsa_key.pub');
  });

  it('a Windows machine owns its three host keys under ProgramData', async () => {
    const out = await lan.run('PC3', 'dir /b C:\\ProgramData\\ssh');
    for (const type of ['rsa', 'ecdsa', 'ed25519']) expect(out).toContain(`ssh_host_${type}_key.pub`);
  });

  it('the host key fingerprints on disk are what ssh-keygen -l reports for them', async () => {
    const out = await sudo('PC6', 'ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub');
    expect(out).toMatch(/^256 SHA256:\S+ root@PC6 \(ED25519\)/);
  });
});

describe.each(CLIENTS)('ssh-keyscan from %s', (client) => {
  it('collects every host key type of a Linux server, one banner per connection', async () => {
    const out = await lan.run(client, `ssh-keyscan ${lan.ip('PC6')}`);
    const keys = out.split(/\r?\n/).filter((l) => !l.startsWith('#') && l.trim() !== '');
    expect(keys.map((k) => k.split(' ')[1]).sort()).toEqual(['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa']);
    expect(out.match(/^# 192\.168\.10\.3:22 SSH-2\.0-OpenSSH_8\.9p1 Ubuntu-3ubuntu0\.\d+/gm)).toHaveLength(5);
    for (const key of keys) expect(key.startsWith(`${lan.ip('PC6')} `)).toBe(true);
  });

  it('collects every host key type of a Windows server', async () => {
    const out = await lan.run(client, `ssh-keyscan ${lan.ip('PC3')}`);
    const keys = out.split(/\r?\n/).filter((l) => !l.startsWith('#') && l.trim() !== '');
    expect(keys.map((k) => k.split(' ')[1]).sort()).toEqual(['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa']);
    expect(out).toContain(`# ${lan.ip('PC3')}:22 SSH-2.0-OpenSSH_for_Windows_8.6`);
  });

  it('the keys it returns are the very keys the server holds', async () => {
    const out = await lan.run(client, `ssh-keyscan -t ed25519 ${lan.ip('PC6')}`);
    const blob = out.split(/\r?\n/).find((l) => l.includes('ssh-ed25519'))!.split(' ')[2];
    const onDisk = await sudo('PC6', 'cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(onDisk.split(' ')[1]).toBe(blob);
    const winOut = await lan.run(client, `ssh-keyscan -t ed25519 ${lan.ip('PC3')}`);
    const winBlob = winOut.split(/\r?\n/).find((l) => l.includes('ssh-ed25519'))!.split(' ')[2];
    const winDisk = await lan.asWindowsAdministrator('PC3', ['type C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub']);
    expect(winDisk.split(' ')[1]).toBe(winBlob);
  });

  it('-t selects a single type: one connection, one banner', async () => {
    const out = await lan.run(client, `ssh-keyscan -t rsa ${lan.ip('PC6')}`);
    expect(out.match(/^# /gm)).toHaveLength(1);
    expect(out).toMatch(/192\.168\.10\.3 ssh-rsa AAAAB3NzaC1yc2E/);
    expect(out).not.toContain('ssh-ed25519');
  });

  it('-t accepts a list of types', async () => {
    const out = await lan.run(client, `ssh-keyscan -t ecdsa,ed25519 ${lan.ip('PC6')}`);
    expect(out).toContain('ecdsa-sha2-nistp256');
    expect(out).toContain('ssh-ed25519');
    expect(out).not.toContain('ssh-rsa');
  });

  it('-H hashes the host name in the output', async () => {
    const out = await lan.run(client, `ssh-keyscan -H -t ed25519 ${lan.ip('PC6')}`);
    expect(out).toMatch(/^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+ ssh-ed25519 AAAA/m);
    expect(out).not.toMatch(/^192\.168\.10\.3 /m);
  });

  it('-p scans another port; a closed port yields no key and status 1', async () => {
    const out = await lan.run(client, lan.platform(client) === 'linux' ? `ssh-keyscan -p 2299 ${lan.ip('PC6')}; echo rc=$?` : `ssh-keyscan -p 2299 ${lan.ip('PC6')} & echo done`);
    expect(out).not.toContain('ssh-');
    if (lan.platform(client) === 'linux') expect(out).toContain('rc=1');
  });

  it('several hosts are scanned in one call, each with its own keys', async () => {
    const out = await lan.run(client, `ssh-keyscan -t ed25519 ${lan.ip('PC6')} ${lan.ip('PC3')} ${lan.ip('Server1')}`);
    for (const host of ['PC6', 'PC3', 'Server1']) expect(out).toContain(`${lan.ip(host)} ssh-ed25519`);
  });

  it('-D prints the SSHFP records of the host keys', async () => {
    const out = await lan.run(client, `ssh-keyscan -D -t ed25519 ${lan.ip('PC6')}`);
    expect(out).toMatch(/192\.168\.10\.3 IN SSHFP 4 1 [0-9a-f]{40}/);
    expect(out).toMatch(/192\.168\.10\.3 IN SSHFP 4 2 [0-9a-f]{64}/);
  });

  it('a host that does not answer yields nothing', async () => {
    const out = await lan.run(client, 'ssh-keyscan -T 2 192.168.77.7');
    expect(out.trim()).toBe('');
  });

  it('prints its usage with no host', async () => {
    const out = await lan.run(client, 'ssh-keyscan');
    expect(out).toContain('usage: ssh-keyscan [-46cDHv] [-f file] [-p port] [-T timeout] [-t type]');
  });

  it('a scan on a stopped server finds nothing', async () => {
    await lan.asWindowsAdministrator('PC4', ['net stop sshd']);
    const out = await lan.run(client, `ssh-keyscan -t ed25519 ${lan.ip('PC4')}`);
    await lan.asWindowsAdministrator('PC4', ['net start sshd']);
    expect(out).not.toContain('ssh-ed25519');
  });
});

describe('ssh-keyscan: its output feeds known_hosts and ssh trusts it', () => {
  it('a scan appended to known_hosts lets a strict client connect without any question', async () => {
    await lan.run('PC2', 'rm -f /tmp/scan-known');
    await lan.run('PC2', `ssh-keyscan -t ed25519 ${lan.ip('PC1')} 2>/dev/null >> /tmp/scan-known`);
    const out = await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/scan-known alice@${lan.ip('PC1')} hostname`);
    expect(out.trim()).toBe('PC1');
  });

  it('the same from a Windows client to a Linux server', async () => {
    await lan.run('PC11', 'del /q C:\\Users\\User\\scan-known');
    await lan.run('PC11', `ssh-keyscan -t ed25519 ${lan.ip('PC6')} >> C:\\Users\\User\\scan-known 2>nul`);
    const out = await lan.run('PC11', `ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=C:\\Users\\User\\scan-known alice@${lan.ip('PC6')} hostname`, 'alice\n');
    expect(out.trim()).toBe('PC6');
  });

  it('a strict client refuses a host it has never seen', async () => {
    await lan.run('PC2', 'rm -f /tmp/empty-known');
    await lan.run('PC2', 'touch /tmp/empty-known');
    const out = await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/empty-known alice@${lan.ip('PC1')} hostname`);
    expect(out).toContain('No ED25519 host key is known for');
    expect(out).toContain('Host key verification failed.');
  });

  it('a scan taken before the server key changed no longer matches', async () => {
    await lan.run('PC2', `ssh-keyscan -t ed25519 ${lan.ip('PC5')} 2>/dev/null > /tmp/stale-known`);
    await sudo('PC5', 'rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await sudo('PC5', 'ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key');
    await sudo('PC5', 'systemctl restart ssh');
    const out = await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/stale-known alice@${lan.ip('PC5')} hostname`);
    expect(out).toContain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!');
    const fresh = await lan.run('PC2', `ssh-keyscan -t ed25519 ${lan.ip('PC5')}`);
    expect(fresh).not.toBe(await lan.run('PC2', 'cat /tmp/stale-known'));
  });
});

describe('known_hosts: -F searches it and -R removes from it', () => {
  it('a Linux client stores the hash of the host name, as Ubuntu does by default', async () => {
    await lan.run('PC2', 'rm -f /home/user/.ssh/known_hosts');
    await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC6')} hostname`);
    const stored = await lan.run('PC2', 'cat /home/user/.ssh/known_hosts');
    expect(stored).toMatch(/^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+ ssh-ed25519 AAAA/m);
    expect(stored).not.toContain(lan.ip('PC6'));
  });

  it('a Windows client stores the host name in clear, as Win32-OpenSSH does by default', async () => {
    await lan.run('PC1', 'del /q C:\\Users\\User\\.ssh\\known_hosts');
    await lan.run('PC1', `ssh ${NOCHECK} alice@${lan.ip('PC6')} hostname`, 'alice\n');
    expect(await lan.run('PC1', 'type C:\\Users\\User\\.ssh\\known_hosts')).toMatch(/^192\.168\.10\.3 ssh-ed25519 AAAA/m);
  });

  it('-F finds a hashed entry from the clear name and prints the line number', async () => {
    const out = await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC6')}`);
    expect(out).toMatch(/^# Host 192\.168\.10\.3 found: line 1 $/m);
    expect(out).toMatch(/^\|1\|\S+\|\S+ ssh-ed25519 AAAA/m);
  });

  it('-F finds a clear entry on Windows', async () => {
    const out = await lan.run('PC1', `ssh-keygen -F ${lan.ip('PC6')}`);
    expect(out).toMatch(/^# Host 192\.168\.10\.3 found: line 1 $/m);
    expect(out).toMatch(/^192\.168\.10\.3 ssh-ed25519 AAAA/m);
  });

  it('-F finds nothing for an unknown host and exits with status 1', async () => {
    const out = await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC10')}; echo rc=$?`);
    expect(out.trim()).toBe('rc=1');
  });

  it('-F -l shows the fingerprint of the stored key', async () => {
    const out = await lan.run('PC1', `ssh-keygen -F ${lan.ip('PC6')} -l`);
    expect(out).toMatch(/^# Host 192\.168\.10\.3 found: line 1 $/m);
    expect(out).toMatch(/^192\.168\.10\.3 ED25519 SHA256:\S+/m);
  });

  it('-F -f reads another file', async () => {
    await lan.run('PC2', `ssh-keyscan -t ed25519 ${lan.ip('PC3')} 2>/dev/null > /tmp/other-known`);
    expect(await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC3')} -f /tmp/other-known`)).toContain('# Host 192.168.30.4 found: line 1');
    expect(await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC3')}; echo rc=$?`)).toContain('rc=1');
  });

  it('-H hashes every clear entry of a known_hosts file', async () => {
    const out = await lan.run('PC1', 'ssh-keygen -H');
    expect(out).toContain('C:\\Users\\User/.ssh/known_hosts updated.');
    expect(out).toContain('Original contents retained as C:\\Users\\User/.ssh/known_hosts.old');
    expect(await lan.run('PC1', 'type C:\\Users\\User\\.ssh\\known_hosts')).toMatch(/^\|1\|/m);
    expect(await lan.run('PC1', `ssh-keygen -F ${lan.ip('PC6')}`)).toContain('found: line 1');
  });

  it('-R removes the entry, says so, and keeps the old file next to the new one (Linux)', async () => {
    const out = await lan.run('PC2', `ssh-keygen -R ${lan.ip('PC6')}`);
    expect(out).toContain('# Host 192.168.10.3 found: line 1');
    expect(out).toContain('/home/user/.ssh/known_hosts updated.');
    expect(out).toContain('Original contents retained as /home/user/.ssh/known_hosts.old');
    expect(await lan.run('PC2', 'ls /home/user/.ssh')).toContain('known_hosts.old');
    expect((await lan.run('PC2', 'cat /home/user/.ssh/known_hosts.old')).length).toBeGreaterThan(0);
    expect(await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC6')}; echo rc=$?`)).toContain('rc=1');
  });

  it('-R removes the entry and keeps the old file on Windows too', async () => {
    const out = await lan.run('PC1', `ssh-keygen -R ${lan.ip('PC6')}`);
    expect(out).toContain('found: line 1');
    expect(await lan.run('PC1', 'dir /b C:\\Users\\User\\.ssh')).toContain('known_hosts.old');
    expect(await lan.run('PC1', `ssh-keygen -F ${lan.ip('PC6')}`)).not.toContain('found');
  });

  it('after -R the next connection asks again and records the new key', async () => {
    await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=accept-new alice@${lan.ip('PC6')} hostname`);
    expect(await lan.run('PC2', `ssh-keygen -F ${lan.ip('PC6')}`)).toContain('found');
  });

  it('-R on a host that is not there says nothing and leaves the file alone', async () => {
    const before = await lan.run('PC2', 'cat /home/user/.ssh/known_hosts');
    const out = await lan.run('PC2', `ssh-keygen -R 192.168.99.99; echo rc=$?`);
    expect(out).not.toContain('updated');
    expect(await lan.run('PC2', 'cat /home/user/.ssh/known_hosts')).toBe(before);
  });

  it('-R fixes a changed key: the same connection then succeeds', async () => {
    await lan.run('PC2', `sshpass -p alice ssh ${NOCHECK} alice@${lan.ip('PC8')} hostname`);
    await sudo('PC8', 'rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await sudo('PC8', 'ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key');
    await sudo('PC8', 'systemctl restart ssh');
    const blocked = await lan.run('PC2', `sshpass -p alice ssh alice@${lan.ip('PC8')} hostname`);
    expect(blocked).toContain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!');
    expect(blocked).toMatch(/Offending ED25519 key in \/home\/user\/\.ssh\/known_hosts:\d+/);
    expect(blocked).toContain(`ssh-keygen -f "/home/user/.ssh/known_hosts" -R "${lan.ip('PC8')}"`);
    await lan.run('PC2', `ssh-keygen -R ${lan.ip('PC8')}`);
    const fixed = await lan.run('PC2', `sshpass -p alice ssh -o StrictHostKeyChecking=accept-new alice@${lan.ip('PC8')} hostname`);
    expect(fixed).toContain('PC8');
  });
});
