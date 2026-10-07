/**
 * Les CRL du simulateur sont du DER réel (RFC 5280 §5 : TBSCertList, crlNumber, raison de
 * révocation) : un openssl 3.x réel lit une CRL produite par `ca -gencrl` du simulateur et la
 * retient contre un certificat révoqué, et le simulateur lit et OPPOSE une CRL fabriquée par un
 * openssl réel (signature vérifiée sur le DER reçu, raison de révocation comprise).
 *
 * MESURÉ avant correctif : la charge d'un bloc X509 CRL était du JSON, openssl répondait « Unable
 * to load CRL » ; la signature portait sur une sérialisation JSON ; ni crlNumber, ni raison de
 * révocation (`-crl_reason`), ni `-crldays` n'existaient ; le premier certificat d'une CA recevait le
 * numéro de série 1001 au lieu de celui du fichier `serial` (1000), et openssl lisait une autre CRL.
 * Mesuré par git stash : avant correctif les 7 cas tombent, aucun n'est neutre (l'oracle est un
 * processus externe). La CRL falsifiée exige « CRL signature failure » mot pour mot, comme chez
 * l'oracle ; le cas WITNESS prouve le laboratoire sain : une CRL intacte laisse passer un
 * certificat non révoqué.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'crlder-'));
const real = (...args: string[]) => spawnSync('openssl', args, { encoding: 'utf8', cwd: dir });
const CA = '/etc/ssl/CA';

async function simulatedAuthority(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'R'); srv.powerOn();
  const sh = (c: string): Promise<string> => srv.executeCommand(c);
  await sh(`mkdir -p ${CA}`);
  await sh(`sh -c 'echo 1000 > ${CA}/serial; echo 1000 > ${CA}/crlnumber; : > ${CA}/index.txt'`);
  await sh(`openssl req -x509 -newkey rsa:1024 -nodes -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -subj "/CN=Lab CA"`);
  for (const name of ['revoked', 'good']) {
    await sh(`openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/${name}.key -out /tmp/${name}.csr -subj "/CN=${name}.lab"`);
    await sh(`openssl ca -config ca.cnf -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/${name}.csr -out /tmp/${name}.crt -days 30`);
  }
  return srv;
}

async function exported(srv: LinuxServer, path: string, name: string): Promise<string> {
  const file = join(dir, name);
  writeFileSync(file, await srv.executeCommand(`cat ${path}`));
  return file;
}

async function imported(srv: LinuxServer, file: string, path: string): Promise<void> {
  await srv.executeCommand(`sh -c 'echo ${readFileSync(file).toString('base64')} | base64 -d > ${path}'`);
}

async function revokeAndPublish(srv: LinuxServer, flags = ''): Promise<void> {
  await srv.executeCommand(`openssl ca -config ca.cnf -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -revoke /tmp/revoked.crt ${flags}`);
  await srv.executeCommand(`openssl ca -config ca.cnf -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -gencrl -out /tmp/c.crl`);
}

describe('CRL ↔ openssl réel', () => {
  it('openssl lit la CRL du simulateur : émetteur, numéro, certificat révoqué et raison', async () => {
    const srv = await simulatedAuthority();
    await revokeAndPublish(srv, '-crl_reason keyCompromise');
    const file = await exported(srv, '/tmp/c.crl', 'sim.crl');
    expect(readFileSync(file, 'utf8')).toContain('BEGIN X509 CRL');
    const text = real('crl', '-in', file, '-noout', '-text').stdout;
    expect(text).toContain('Issuer: CN = Lab CA');
    expect(text).toContain('X509v3 CRL Number');
    expect(text).toContain('4096');
    expect(text).toContain('Serial Number: 1000');
    expect(text).toContain('Key Compromise');
  });

  it('openssl retient la CRL du simulateur contre le certificat révoqué', async () => {
    const srv = await simulatedAuthority();
    await revokeAndPublish(srv);
    const crl = await exported(srv, '/tmp/c.crl', 'sim2.crl');
    const ca = await exported(srv, `${CA}/ca.crt`, 'sim-ca.crt');
    const revoked = await exported(srv, '/tmp/revoked.crt', 'sim-revoked.crt');
    const verdict = real('verify', '-crl_check', '-CAfile', ca, '-CRLfile', crl, revoked);
    expect(verdict.stdout + verdict.stderr).toContain('certificate revoked');
  });

  it('WITNESS — la même CRL laisse passer le certificat qui n\'est pas révoqué', async () => {
    const srv = await simulatedAuthority();
    await revokeAndPublish(srv);
    const crl = await exported(srv, '/tmp/c.crl', 'sim3.crl');
    const ca = await exported(srv, `${CA}/ca.crt`, 'sim-ca3.crt');
    const good = await exported(srv, '/tmp/good.crt', 'sim-good.crt');
    expect(real('verify', '-crl_check', '-CAfile', ca, '-CRLfile', crl, good).stdout).toContain(': OK');
  });

  it('le simulateur relit sa CRL et en donne le même texte qu\'openssl', async () => {
    const srv = await simulatedAuthority();
    await revokeAndPublish(srv, '-crl_reason superseded');
    const file = await exported(srv, '/tmp/c.crl', 'sim4.crl');
    const expected = real('crl', '-in', file, '-noout', '-text').stdout.trim();
    expect((await srv.executeCommand('openssl crl -in /tmp/c.crl -noout -text')).trim()).toBe(expected);
  });

  it('une raison inconnue est refusée dans les mots d\'openssl', async () => {
    const srv = await simulatedAuthority();
    const refused = await srv.executeCommand(`openssl ca -config ca.cnf -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -revoke /tmp/revoked.crt -crl_reason nonsense 2>&1`);
    expect(refused).toContain('Unknown CRL reason nonsense');
  });

  it('le simulateur oppose une CRL fabriquée par openssl (raison comprise)', async () => {
    const authority = join(dir, 'real-ca');
    mkdirSync(join(authority, 'newcerts'), { recursive: true });
    writeFileSync(join(authority, 'index.txt'), '');
    writeFileSync(join(authority, 'serial'), '1000\n');
    writeFileSync(join(authority, 'crlnumber'), '2000\n');
    writeFileSync(join(authority, 'ca.cnf'), `[ca]\ndefault_ca=d\n[d]\ndir=${authority}\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/newcerts\nserial=$dir/serial\ncrlnumber=$dir/crlnumber\ndefault_md=sha256\npolicy=p\ndefault_days=30\ndefault_crl_days=30\n[p]\ncommonName=supplied\n`);
    const run = (...args: string[]) => spawnSync('openssl', args, { cwd: authority, encoding: 'utf8' });
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Real CA', '-days', '100');
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'l.key', '-out', 'l.csr', '-subj', '/CN=leaf.real');
    run('ca', '-config', 'ca.cnf', '-batch', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-in', 'l.csr', '-out', 'l.crt', '-notext');
    run('ca', '-config', 'ca.cnf', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-revoke', 'l.crt', '-crl_reason', 'keyCompromise');
    run('ca', '-config', 'ca.cnf', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-gencrl', '-out', 'c.crl');

    const srv = new LinuxServer('linux-server', 'V'); srv.powerOn();
    await imported(srv, join(authority, 'c.crl'), '/tmp/real.crl');
    await imported(srv, join(authority, 'ca.crt'), '/tmp/real-ca.crt');
    await imported(srv, join(authority, 'l.crt'), '/tmp/real-leaf.crt');
    const text = await srv.executeCommand('openssl crl -in /tmp/real.crl -noout -text');
    expect(text).toContain('Issuer: CN = Real CA');
    expect(text).toContain('Key Compromise');
    expect(text).toContain('8192');
    const verdict = await srv.executeCommand('openssl verify -crl_check -CAfile /tmp/real-ca.crt -CRLfile /tmp/real.crl /tmp/real-leaf.crt 2>&1');
    expect(verdict).toContain('revoked');
  });

  it('une CRL falsifiée n\'est pas opposable : la signature ne couvre plus la liste', async () => {
    const srv = await simulatedAuthority();
    await revokeAndPublish(srv);
    const file = await exported(srv, '/tmp/c.crl', 'sim5.crl');
    const body = Buffer.from(readFileSync(file, 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
    body[body.length - 1] ^= 0x01;
    const forged = join(dir, 'forged.crl');
    writeFileSync(forged, `-----BEGIN X509 CRL-----\n${body.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END X509 CRL-----\n`);
    await imported(srv, forged, '/tmp/forged.crl');
    const verdict = await srv.executeCommand(`openssl verify -crl_check -CAfile ${CA}/ca.crt -CRLfile /tmp/forged.crl /tmp/good.crt 2>&1`);
    expect(verdict).toContain('CRL signature failure');
    const ca = await exported(srv, `${CA}/ca.crt`, 'forged-ca.crt');
    const good = await exported(srv, '/tmp/good.crt', 'forged-good.crt');
    const oracle = real('verify', '-crl_check', '-CAfile', ca, '-CRLfile', forged, good);
    expect(oracle.stdout + oracle.stderr).toContain('CRL signature failure');
  });
});
