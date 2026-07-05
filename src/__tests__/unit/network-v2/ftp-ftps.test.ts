import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { FtpServerConfig } from '@/network/ftp/FtpServerSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

const NOW = Date.now();

function issueServerCert() {
  const ca = CertificateAuthority.generate('CN=ftps-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=ftp.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function buildTopology(configOverrides: Partial<FtpServerConfig> = {}, ftpsClientConfig?: { verifier: CertificateVerifier }) {
  const pc = new WindowsPC('windows-pc', 'PC1');
  const srv = new LinuxServer('FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfs.writeFile('/srv/ftp/hello.txt', 'hello ftp world', 1000, 1000, 0o022);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);

  const users = new Map([['alice', 'wonderland']]);
  const server = new FtpServer(srv.getTcpStack(), '10.0.1.10', { users, fs, rootPath: '/srv/ftp', ...configOverrides });
  server.start();

  const client = new FtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', undefined, ftpsClientConfig);
  return { pc, srv, vfs, client };
}

describe('FTPS — AUTH TLS control-channel upgrade (RFC 2228/4217)', () => {
  it('completes a real TLS 1.3 handshake and transparently encrypts everything after the 234 reply', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    client.connect();

    const authReply = client.authTls();
    expect(authReply?.code).toBe(234);

    // Everything from here on is carried inside real TLS records; a plain
    // FTP login still works, now protected.
    expect(client.sendCommand({ verb: 'USER', argument: 'alice' })?.code).toBe(331);
    expect(client.sendCommand({ verb: 'PASS', argument: 'wonderland' })?.code).toBe(230);
    expect(client.sendCommand({ verb: 'PWD' })?.code).toBe(257);
  });

  it('replies 502 to AUTH TLS when the server has no FTPS configuration', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'AUTH', argument: 'TLS' })?.code).toBe(502);
  });

  it('replies 504 to an unsupported AUTH mechanism', () => {
    const { issued } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } });
    client.connect();
    expect(client.sendCommand({ verb: 'AUTH', argument: 'KERBEROS' })?.code).toBe(504);
  });

  it('rejects a server certificate issued by an untrusted CA before any command is exchanged', () => {
    const { issued } = issueServerCert();
    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const rogueVerifier = new CertificateVerifier({ trustAnchors: [rogueCa.rootCertificate], clock: () => NOW });
    const { client } = buildTopology(
      { ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } },
      { verifier: rogueVerifier },
    );
    client.connect();
    const authReply = client.authTls();
    expect(authReply?.code).toBe(234);
    // The handshake itself fails; no plaintext command should get an
    // authenticated-looking reply back over a channel that isn't secure.
    expect(client.sendCommand({ verb: 'USER', argument: 'alice' })).toBeNull();
  });

  it('rejects PBSZ/PROT before AUTH TLS with 503', () => {
    const { issued } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } });
    client.connect();
    expect(client.sendCommand({ verb: 'PBSZ', argument: '0' })?.code).toBe(503);
    expect(client.sendCommand({ verb: 'PROT', argument: 'P' })?.code).toBe(503);
  });

  it('PBSZ only accepts a size of 0', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    client.connect();
    client.authTls();
    expect(client.sendCommand({ verb: 'PBSZ', argument: '1024' })?.code).toBe(501);
    expect(client.sendCommand({ verb: 'PBSZ', argument: '0' })?.code).toBe(200);
  });

  it('rejects a second AUTH TLS once the control channel is already protected', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    client.connect();
    client.authTls();
    client.sendCommand({ verb: 'PBSZ', argument: '0' });
    expect(client.sendCommand({ verb: 'AUTH', argument: 'TLS' })?.code).toBe(503);
  });
});

describe('FTPS — PROT P data-channel protection (RFC 4217 §4)', () => {
  function loginProtected(client: FtpClientSession): void {
    client.connect();
    client.authTls();
    client.sendCommand({ verb: 'PBSZ', argument: '0' });
    client.sendCommand({ verb: 'USER', argument: 'alice' });
    client.sendCommand({ verb: 'PASS', argument: 'wonderland' });
  }

  it('PROT P negotiates successfully and a PASV data connection under it also completes a real TLS handshake', () => {
    const { issued, verifier } = issueServerCert();
    const { client, vfs } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    loginProtected(client);

    expect(client.setDataProtectionLevel('P')?.code).toBe(200);
    client.enterPassiveMode();
    const reply = client.storeFile('protected.txt', 'this went over a TLS-protected data channel');
    expect(reply?.code).toBe(226);
    // On disk, the server always keeps the plain (decrypted) bytes.
    expect(vfs.readFile('/srv/ftp/protected.txt')).toBe('this went over a TLS-protected data channel');
  });

  it('downloads a file byte-exact over a PROT P data connection', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    loginProtected(client);
    client.setDataProtectionLevel('P');

    client.enterPassiveMode();
    const { reply, content } = client.retrieveFile('hello.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('hello ftp world');
  });

  it('PROT C (the default) leaves the data channel in the clear even once the control channel is protected', () => {
    const { issued, verifier } = issueServerCert();
    const { client, vfs } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    loginProtected(client);

    expect(client.setDataProtectionLevel('C')?.code).toBe(200);
    client.enterPassiveMode();
    const reply = client.storeFile('cleartext.txt', 'not protected');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/cleartext.txt')).toBe('not protected');
  });

  it('rejects an unrecognized PROT parameter with 504', () => {
    const { issued, verifier } = issueServerCert();
    const { client } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } }, { verifier });
    loginProtected(client);
    expect(client.sendCommand({ verb: 'PROT', argument: 'E' })?.code).toBe(504);
  });
});
