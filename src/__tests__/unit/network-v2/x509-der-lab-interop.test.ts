/**
 * Les certificats du simulateur sont du DER X.509 réel (RFC 5280) : un openssl
 * réel lit ce que `openssl req`/`openssl ca` du simulateur écrivent et vérifie
 * leurs signatures, et le simulateur lit et vérifie ce qu'un openssl réel fabrique.
 *
 * MESURÉ avant correctif : la charge d'un bloc CERTIFICATE était du JSON
 * (`{"version":3,"serialNumber":…}`) signé sur une sérialisation JSON ; un openssl réel
 * répondait « Could not read certificate », et les certificats d'un openssl réel
 * étaient illisibles pour le simulateur. Les extensions AIA/SAN/EKU/AKI n'avaient
 * aucune forme DER.
 *
 * Avant correctif, 4 des 5 cas tombent ; le témoin (le simulateur relit ses
 * propres fichiers) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'x509lab-'));
const real = (...args: string[]): string => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const CA = '/etc/ssl/CA';

async function simulatedLab(): Promise<{ srv: LinuxServer; caPem: string; leafPem: string }> {
  const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
  const sh = (c: string): Promise<string> => srv.executeCommand(c);
  await sh(`mkdir -p ${CA}`);
  await sh(`openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/C=FR/O=Lab/CN=Lab CA"`);
  await sh(`sh -c 'printf "subjectAltName=DNS:www.lab,IP:10.0.0.9\\nextendedKeyUsage=serverAuth\\n" > /tmp/leaf.ext'`);
  await sh('openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/leaf.key -out /tmp/leaf.csr -subj "/CN=www.lab"');
  await sh(`openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/leaf.csr -extfile /tmp/leaf.ext -out /tmp/leaf.crt -days 30`);
  return { srv, caPem: await sh(`cat ${CA}/ca.crt`), leafPem: await sh('cat /tmp/leaf.crt') };
}

describe('certificats du simulateur ↔ openssl réel', () => {
  it('témoin : le simulateur relit ses propres fichiers', async () => {
    const { srv } = await simulatedLab();
    expect(await srv.executeCommand('openssl x509 -in /tmp/leaf.crt -noout -subject')).toContain('subject=CN = www.lab');
  });

  it('openssl réel lit un certificat écrit par `openssl req -x509` du simulateur', async () => {
    const { caPem } = await simulatedLab();
    const path = join(dir, 'sim-ca.pem');
    writeFileSync(path, caPem);
    expect(real('x509', '-in', path, '-noout', '-subject', '-issuer')).toContain('subject=C = FR, O = Lab, CN = Lab CA');
  });

  it('openssl réel vérifie la signature d\'un certificat émis par `openssl ca` du simulateur', async () => {
    const { caPem, leafPem } = await simulatedLab();
    writeFileSync(join(dir, 'ca2.pem'), caPem);
    writeFileSync(join(dir, 'leaf2.pem'), leafPem);
    expect(real('verify', '-CAfile', join(dir, 'ca2.pem'), join(dir, 'leaf2.pem'))).toContain('OK');
    expect(real('x509', '-in', join(dir, 'leaf2.pem'), '-noout', '-ext', 'subjectAltName,extendedKeyUsage')).toContain('DNS:www.lab, IP Address:10.0.0.9');
  });

  it('le simulateur lit et vérifie une chaîne fabriquée par un openssl réel', async () => {
    const caKey = join(dir, 'real-ca.key'); const caCrt = join(dir, 'real-ca.pem');
    const key = join(dir, 'real-leaf.key'); const csr = join(dir, 'real-leaf.csr'); const crt = join(dir, 'real-leaf.pem');
    real('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCrt, '-days', '30', '-subj', '/C=FR/O=Real/CN=Real CA');
    real('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=real.lab');
    real('x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', crt, '-days', '10');
    const srv = new LinuxServer('linux-server', 'R'); srv.powerOn();
    const place = (source: string, target: string): Promise<string> =>
      srv.executeCommand(`sh -c 'echo ${readFileSync(source).toString('base64')} | base64 -d > ${target}'`);
    await place(caCrt, '/tmp/real-ca.pem');
    await place(crt, '/tmp/real-leaf.pem');
    expect(await srv.executeCommand('openssl x509 -in /tmp/real-leaf.pem -noout -subject -issuer'))
      .toContain('subject=CN = real.lab\nissuer=C = FR, O = Real, CN = Real CA');
    expect(await srv.executeCommand('openssl verify -CAfile /tmp/real-ca.pem /tmp/real-leaf.pem')).toContain('OK');
  });

  it('empreinte SHA-256 : celle d\'un openssl réel sur le même fichier', async () => {
    const { srv, leafPem } = await simulatedLab();
    writeFileSync(join(dir, 'leaf3.pem'), leafPem);
    const expected = real('x509', '-in', join(dir, 'leaf3.pem'), '-noout', '-fingerprint', '-sha256').trim().replace('sha256 Fingerprint=', 'SHA256 Fingerprint=');
    expect((await srv.executeCommand('openssl x509 -in /tmp/leaf.crt -noout -fingerprint -sha256')).trim()).toBe(expected);
  });
});
