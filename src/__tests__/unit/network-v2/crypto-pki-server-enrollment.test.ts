/**
 * `crypto pki authenticate` / `crypto pki enroll` used to look the CA up in a process-wide registry
 * keyed by the enrollment URL: no frame left the router, `enrollment url http://nowhere` enrolled
 * happily, and nothing on the network had to be a certificate server. Enrollment is now an HTTP
 * exchange (GetCACert, PKIOperation, GetCertInitial under /cgi-bin/pkiclient.exe) between the client
 * and the IOS certificate server (`crypto pki server NAME`) that rides the router HTTP server.
 *
 * Lab: R1 - CA, real frames; the tap on the CA counts the TCP segments addressed to port 80.
 * Discriminated with `git stash push -- src/network`: 13 of the 14 cases fall before the change (no
 * `crypto pki server` mode, no wire exchange). The witness that passes either way is "enroll before
 * authenticate is refused": an ordering rule the old mock already enforced.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function run(router: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await router.executeCommand(line));
  return out;
}

interface PkiLab { client: CiscoRouter; ca: CiscoRouter; segmentsToCa: { count: number } }

async function pkiLab(caConfig: string[] = ['grant auto', 'no shutdown'], httpServer = true): Promise<PkiLab> {
  const client = new CiscoRouter('CLIENT');
  const ca = new CiscoRouter('CA');
  new Cable('pki').connect(client.getPort('GigabitEthernet0/0')!, ca.getPort('GigabitEthernet0/0')!);
  const segmentsToCa = { count: 0 };
  ca.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    if (direction !== 'in') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const tcp = packet?.type === 'ipv4' ? packet.payload as { type?: string; destinationPort?: number } : undefined;
    if (tcp?.type === 'tcp' && tcp.destinationPort === 80) segmentsToCa.count++;
  });
  await run(client, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.9.0.2 255.255.255.0', 'no shutdown', 'end']);
  await run(ca, [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown', 'exit',
    ...(httpServer ? ['ip http server'] : []),
    'crypto pki server CS', 'issuer-name CN=LAB-ROOT', ...caConfig, 'end',
  ]);
  return { client, ca, segmentsToCa };
}

const trustpoint = (url = 'http://10.9.0.1', extra: string[] = []): string[] => [
  'configure terminal', 'crypto pki trustpoint TP', `enrollment url ${url}`, 'subject-name CN=client.lab', ...extra, 'exit',
];

describe('IOS certificate server — enrollment on the wire', () => {
  it('authenticate fetches the CA certificate over TCP port 80', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint());
    const before = lab.segmentsToCa.count;
    const out = await lab.client.executeCommand('crypto pki authenticate TP');
    expect(lab.segmentsToCa.count - before).toBeGreaterThanOrEqual(3);
    expect(out).toContain('Fingerprint SHA1:');
    expect(out).toContain('Trustpoint CA certificate accepted');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.caCert!.subject).toContain('LAB-ROOT');
  });

  it('enroll puts more frames on the wire and installs a certificate signed by the answering CA', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint());
    await lab.client.executeCommand('crypto pki authenticate TP');
    const before = lab.segmentsToCa.count;
    const out = await lab.client.executeCommand('crypto pki enroll TP');
    expect(lab.segmentsToCa.count - before).toBeGreaterThanOrEqual(3);
    expect(out).toContain('Router Certificate successfully imported');
    const local = getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert!;
    expect(local.subject).toContain('client.lab');
    expect(local.issuer).toContain('LAB-ROOT');
  });

  it('an enrollment url that nobody serves is an error, not an enrollment', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint('http://10.9.0.77'));
    const out = await lab.client.executeCommand('crypto pki authenticate TP');
    expect(out).toContain('% Error in receiving Certificate Authority certificate');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.caCert).toBeUndefined();
  });

  it('the certificate server needs the router HTTP server: without it the port is closed', async () => {
    const lab = await pkiLab(['grant auto', 'no shutdown'], false);
    await run(lab.client, trustpoint());
    const out = await lab.client.executeCommand('crypto pki authenticate TP');
    expect(out).toContain('% Error in receiving Certificate Authority certificate');
  });

  it('a shut-down server answers 503 and nothing is authenticated', async () => {
    const lab = await pkiLab(['grant auto']);
    await run(lab.client, trustpoint());
    const out = await lab.client.executeCommand('crypto pki authenticate TP');
    expect(out).toContain('% Error in receiving Certificate Authority certificate');
  });

  it('enroll before authenticate is refused', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint());
    expect(await lab.client.executeCommand('crypto pki enroll TP')).toMatch(/not authenticated/i);
  });

  it('manual granting: the request waits, `grant all` issues it, enroll collects it', async () => {
    const lab = await pkiLab(['no shutdown']);
    await run(lab.client, trustpoint());
    await lab.client.executeCommand('crypto pki authenticate TP');
    const first = await lab.client.executeCommand('crypto pki enroll TP');
    expect(first).toContain('pending');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert).toBeUndefined();
    await lab.ca.executeCommand('enable');
    const requests = await lab.ca.executeCommand('show crypto pki server CS requests');
    expect(requests).toContain('client.lab');
    expect(requests).toContain('pending');
    expect(await lab.ca.executeCommand('crypto pki server CS grant all')).toContain('1 request(s) granted');
    const second = await lab.client.executeCommand('crypto pki enroll TP');
    expect(second).toContain('Router Certificate successfully imported');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert!.issuer).toContain('LAB-ROOT');
  });

  it('a rejected request is reported as rejected', async () => {
    const lab = await pkiLab(['no shutdown']);
    await run(lab.client, trustpoint());
    await lab.client.executeCommand('crypto pki authenticate TP');
    await lab.client.executeCommand('crypto pki enroll TP');
    await lab.ca.executeCommand('enable');
    await lab.ca.executeCommand('crypto pki server CS reject all');
    expect(await lab.client.executeCommand('crypto pki enroll TP')).toContain('rejected');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert).toBeUndefined();
  });

  it('the trustpoint fingerprint is evaluated: a wrong one refuses the CA, the right one accepts it', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint('http://10.9.0.1', ['fingerprint 00000000 00000000 00000000 00000000']));
    const wrong = await lab.client.executeCommand('crypto pki authenticate TP');
    expect(wrong).toContain('fingerprint mismatch');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.caCert).toBeUndefined();

    const probe = await lab.client.executeCommand('crypto pki authenticate TP');
    const sha1 = /Fingerprint SHA1: ([0-9A-F ]+)/.exec(probe)![1].trim();
    await run(lab.client, ['configure terminal', 'crypto pki trustpoint TP', `fingerprint ${sha1}`, 'exit']);
    const right = await lab.client.executeCommand('crypto pki authenticate TP');
    expect(right).toContain('fingerprint matched');
    expect(getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.caCert).toBeDefined();
  });

  it('`crypto ca` is the same family as `crypto pki`', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint());
    const out = await lab.client.executeCommand('crypto ca authenticate TP');
    expect(out).toContain('Trustpoint CA certificate accepted');
    expect(await lab.client.executeCommand('crypto ca enroll TP')).toContain('successfully imported');
  });

  it('revocation appears in the server CRL', async () => {
    const lab = await pkiLab();
    await run(lab.client, trustpoint());
    await lab.client.executeCommand('crypto pki authenticate TP');
    await lab.client.executeCommand('crypto pki enroll TP');
    const serial = getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert!.serialNumber;
    await lab.ca.executeCommand('enable');
    expect(await lab.ca.executeCommand(`crypto pki server CS revoke ${serial}`)).toBe('');
    expect(await lab.ca.executeCommand('show crypto pki server CS crl')).toContain(serial);
    expect(await lab.ca.executeCommand('crypto pki server CS revoke deadbeef')).toContain('was not issued');
  });

  it('the server cannot start without an issuer name, and the block is read back by the running-config', async () => {
    const ca = new CiscoRouter('CA2');
    await run(ca, ['enable', 'configure terminal', 'crypto pki server CS']);
    expect(await ca.executeCommand('no shutdown')).toContain('issuer-name');
    await run(ca, ['issuer-name CN=ROOT2', 'grant auto', 'lifetime certificate 90', 'no shutdown', 'end']);
    const config = await ca.executeCommand('show running-config');
    expect(config).toContain('crypto pki server CS');
    expect(config).toContain(' issuer-name CN=ROOT2');
    expect(config).toContain(' grant auto');
    expect(config).toContain(' lifetime certificate 90');
    expect(config).not.toMatch(/crypto pki server CS[\s\S]*? shutdown/);
    expect(await ca.executeCommand('show crypto pki server CS')).toContain('Granting mode is: auto');
  });

  it('issued certificates honour `lifetime certificate`', async () => {
    const lab = await pkiLab(['grant auto', 'lifetime certificate 30', 'no shutdown']);
    await run(lab.client, trustpoint());
    await lab.client.executeCommand('crypto pki authenticate TP');
    await lab.client.executeCommand('crypto pki enroll TP');
    const cert = getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert!;
    expect(Math.round((cert.notAfter - cert.notBefore) / 86_400_000)).toBe(30);
  });

  it('stop, start, unrevoke, remove and info requests act on the server state', async () => {
    const lab = await pkiLab(['no shutdown']);
    await lab.ca.executeCommand('enable');
    await run(lab.client, trustpoint());
    await lab.client.executeCommand('crypto pki authenticate TP');
    await lab.client.executeCommand('crypto pki enroll TP');
    expect(await lab.ca.executeCommand('crypto pki server CS info requests')).toContain('client.lab');
    expect(await lab.ca.executeCommand('crypto pki server CS grant 1')).toContain('1 request(s) granted');
    const serial = getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert === undefined
      ? (await lab.client.executeCommand('crypto pki enroll TP'), getSecurityConfig(lab.client).pkiTrustpoints.get('TP')!.localCert!.serialNumber)
      : '';
    expect(await lab.ca.executeCommand(`crypto pki server CS revoke ${serial}`)).toBe('');
    expect(await lab.ca.executeCommand('crypto pki server CS info crl')).toContain(serial);
    expect(await lab.ca.executeCommand(`crypto pki server CS unrevoke ${serial}`)).toBe('');
    expect(await lab.ca.executeCommand('crypto pki server CS info crl')).not.toContain(`Serial Number: ${serial}`);
    await lab.ca.executeCommand('crypto pki server CS stop');
    await run(lab.client, trustpoint('http://10.9.0.1'));
    expect(await lab.client.executeCommand('crypto pki authenticate TP')).toContain('% Error in receiving');
    await lab.ca.executeCommand('crypto pki server CS start');
    expect(await lab.client.executeCommand('crypto pki authenticate TP')).toContain('accepted');
    expect(await lab.ca.executeCommand('crypto pki server CS remove all')).toBe('');
    expect(await lab.ca.executeCommand('crypto pki server CS remove all')).toContain('No enrollment request');
  });
});
