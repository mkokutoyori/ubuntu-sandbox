/**
 * Les messages OCSP du simulateur sont du DER réel (RFC 6960 : OCSPRequest, OCSPResponse /
 * BasicOCSPResponse, CertID haché en SHA-1, nonce, responderID, raison de révocation) : un openssl
 * 3.x réel lit les demandes et réponses que `ocsp` du simulateur écrit (`-reqout`/`-respout` sont du
 * DER binaire, comme chez openssl), vérifie la signature de la réponse, et le simulateur lit et
 * vérifie celles qu'un openssl réel fabrique. Le CertID prend la forme réelle : empreintes du nom de
 * l'émetteur (DER du certificat) et de la clé publique, plus le numéro de série.
 *
 * MESURÉ avant correctif : le CertID portait le nom d'émetteur en clair et les messages étaient du
 * JSON armuré ; openssl répondait « Error reading OCSP request » et ne lisait aucune réponse ; les
 * fichiers de requête et de réponse étaient du texte ; une réponse sans -ndays/-nmin portait quand
 * même un nextUpdate de quatre jours, là où openssl n'en met pas ; la raison de révocation n'existait
 * pas. Avant correctif, les 7 cas tombent (mesuré par git stash) ; aucun n'est neutre, l'oracle
 * étant un processus externe. Le cas WITNESS prouve le laboratoire sain : une réponse intacte est
 * acceptée par openssl, la falsification est donc le seul écart du cas voisin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'ocspder-'));
const real = (...args: string[]) => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
const CA = '/etc/ssl/CA';

interface Lab { readonly srv: LinuxServer; readonly ca: string; readonly good: string; readonly revoked: string }

function exportBinary(srv: LinuxServer, path: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.from(fileTextToBytes(srv.readTextFile(path) ?? '')));
  return file;
}

function importBinary(srv: LinuxServer, file: string, path: string): void {
  srv.writeTextFile(path, bytesToFileText(readFileSync(file)));
}

function exportText(srv: LinuxServer, path: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, srv.readTextFile(path) ?? '');
  return file;
}

async function simulatedAuthority(tag: string): Promise<Lab> {
  const srv = new LinuxServer('linux-server', tag); srv.powerOn();
  const sh = (c: string): Promise<string> => srv.executeCommand(c);
  await sh(`mkdir -p ${CA}`);
  await sh(`sh -c 'echo 1000 > ${CA}/serial; : > ${CA}/index.txt'`);
  await sh(`openssl req -x509 -newkey rsa:1024 -nodes -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -subj "/CN=Lab CA"`);
  for (const name of ['good', 'revoked']) {
    await sh(`openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/${name}.key -out /tmp/${name}.csr -subj "/CN=${name}.lab"`);
    await sh(`openssl ca -config ca.cnf -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/${name}.csr -out /tmp/${name}.crt -days 30`);
  }
  await sh(`openssl ca -config ca.cnf -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -revoke /tmp/revoked.crt -crl_reason keyCompromise`);
  return {
    srv,
    ca: exportText(srv, `${CA}/ca.crt`, `${tag}-ca.crt`),
    good: exportText(srv, '/tmp/good.crt', `${tag}-good.crt`),
    revoked: exportText(srv, '/tmp/revoked.crt', `${tag}-revoked.crt`),
  };
}

const RESPONDER = `-index ${CA}/index.txt -CA ${CA}/ca.crt -rsigner ${CA}/ca.crt -rkey ${CA}/ca.key`;

async function simulatedExchange(lab: Lab, cert: string, flags = ''): Promise<void> {
  await lab.srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert ${cert} -no_nonce -reqout /tmp/q.der`);
  await lab.srv.executeCommand(`openssl ocsp -reqin /tmp/q.der ${RESPONDER} ${flags} -respout /tmp/r.der`);
}

describe('OCSP DER ↔ openssl réel', () => {
  it('openssl lit la requête du simulateur : mêmes empreintes que celles qu\'il calcule lui-même', async () => {
    const lab = await simulatedAuthority('Q');
    await lab.srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -no_nonce -reqout /tmp/q.der`);
    const request = exportBinary(lab.srv, '/tmp/q.der', 'sim.req');
    const shown = real('ocsp', '-reqin', request, '-text', '-noverify').stdout;
    const expected = real('ocsp', '-issuer', lab.ca, '-cert', lab.good, '-no_nonce', '-reqout', join(dir, 'real.req'), '-text').stdout;
    for (const label of ['Hash Algorithm: sha1', 'Issuer Name Hash:', 'Issuer Key Hash:', 'Serial Number:']) {
      const pick = (text: string) => text.split('\n').find((line) => line.includes(label))?.trim();
      expect(pick(shown)).toBeDefined();
      expect(pick(shown)).toBe(pick(expected));
    }
  });

  it('openssl vérifie la signature de la réponse du simulateur et lit « good »', async () => {
    const lab = await simulatedAuthority('G');
    await simulatedExchange(lab, '/tmp/good.crt');
    const response = exportBinary(lab.srv, '/tmp/r.der', 'sim-good.resp');
    const verdict = real('ocsp', '-issuer', lab.ca, '-cert', lab.good, '-no_nonce', '-respin', response, '-CAfile', lab.ca);
    expect(verdict.stderr).toContain('Response verify OK');
    expect(verdict.stdout).toContain('good.crt: good');
  });

  it('openssl lit « revoked », la raison et le texte complet de la réponse', async () => {
    const lab = await simulatedAuthority('R');
    await simulatedExchange(lab, '/tmp/revoked.crt', '-ndays 2');
    const response = exportBinary(lab.srv, '/tmp/r.der', 'sim-revoked.resp');
    const verdict = real('ocsp', '-issuer', lab.ca, '-cert', lab.revoked, '-no_nonce', '-respin', response, '-CAfile', lab.ca);
    expect(verdict.stdout).toContain('revoked.crt: revoked');
    expect(verdict.stdout).toContain('Reason: keyCompromise');
    const upTo = (text: string) => text.slice(text.indexOf('OCSP Response Data'), text.indexOf('Signature Value'));
    const oracle = real('ocsp', '-respin', response, '-noverify', '-text').stdout;
    const shown = await lab.srv.executeCommand('openssl ocsp -respin /tmp/r.der -noverify -text');
    expect(upTo(shown)).toBe(upTo(oracle));
  });

  it('sans -ndays ni -nmin la réponse n\'a pas de nextUpdate, comme openssl', async () => {
    const lab = await simulatedAuthority('N');
    await simulatedExchange(lab, '/tmp/good.crt');
    const response = exportBinary(lab.srv, '/tmp/r.der', 'sim-open.resp');
    const text = real('ocsp', '-respin', response, '-noverify', '-text').stdout;
    expect(text).toContain('This Update');
    expect(text).not.toContain('Next Update');
  });

  it('WITNESS — la réponse intacte est acceptée, la même avec un octet de signature changé est refusée', async () => {
    const lab = await simulatedAuthority('F');
    await simulatedExchange(lab, '/tmp/good.crt');
    const response = exportBinary(lab.srv, '/tmp/r.der', 'sim-f.resp');
    const intact = real('ocsp', '-issuer', lab.ca, '-cert', lab.good, '-no_nonce', '-respin', response, '-CAfile', lab.ca);
    expect(intact.stderr).toContain('Response verify OK');

    const bytes = readFileSync(response);
    const text = real('ocsp', '-respin', response, '-noverify', '-text').stdout;
    const signatureHex = text.slice(text.indexOf('Signature Value:')).split('\n')[1].trim().split(':').slice(0, 8).join('');
    const at = bytes.indexOf(Buffer.from(signatureHex, 'hex'));
    expect(at).toBeGreaterThan(0);
    bytes[at + 3] ^= 0x01;
    const forged = join(dir, 'forged.resp');
    writeFileSync(forged, bytes);
    const refused = real('ocsp', '-issuer', lab.ca, '-cert', lab.good, '-no_nonce', '-respin', forged, '-CAfile', lab.ca);
    expect(refused.stderr).toContain('Response Verify Failure');
    importBinary(lab.srv, forged, '/tmp/forged.der');
    const simulated = await lab.srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -no_nonce -respin /tmp/forged.der -CAfile ${CA}/ca.crt 2>&1`);
    expect(simulated).toContain('Response Verify Failure');
  });

  it('le simulateur lit la réponse d\'un répondeur openssl réel, la vérifie et lit la raison', () => {
    const authority = join(dir, 'real-ca');
    mkdirSync(join(authority, 'newcerts'), { recursive: true });
    writeFileSync(join(authority, 'index.txt'), '');
    writeFileSync(join(authority, 'serial'), '1000\n');
    writeFileSync(join(authority, 'ca.cnf'), `[ca]\ndefault_ca=d\n[d]\ndir=${authority}\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/newcerts\nserial=$dir/serial\ndefault_md=sha256\npolicy=p\ndefault_days=30\n[p]\ncommonName=supplied\n`);
    const run = (...args: string[]) => spawnSync('openssl', args, { cwd: authority, encoding: 'utf8' });
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Real CA', '-days', '100');
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'l.key', '-out', 'l.csr', '-subj', '/CN=leaf.real');
    run('ca', '-config', 'ca.cnf', '-batch', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-in', 'l.csr', '-out', 'l.crt', '-notext');
    run('ca', '-config', 'ca.cnf', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-revoke', 'l.crt', '-crl_reason', 'superseded');
    run('ocsp', '-issuer', 'ca.crt', '-cert', 'l.crt', '-no_nonce', '-reqout', 'q.der');
    run('ocsp', '-reqin', 'q.der', '-index', 'index.txt', '-CA', 'ca.crt', '-rsigner', 'ca.crt', '-rkey', 'ca.key', '-ndays', '3', '-respout', 'r.der');

    const srv = new LinuxServer('linux-server', 'V'); srv.powerOn();
    importBinary(srv, join(authority, 'r.der'), '/tmp/real.der');
    importBinary(srv, join(authority, 'ca.crt'), '/tmp/real-ca.crt');
    importBinary(srv, join(authority, 'l.crt'), '/tmp/real-leaf.crt');
    importBinary(srv, join(authority, 'q.der'), '/tmp/real-q.der');
    return srv.executeCommand('openssl ocsp -issuer /tmp/real-ca.crt -cert /tmp/real-leaf.crt -no_nonce -respin /tmp/real.der -CAfile /tmp/real-ca.crt 2>&1').then((out) => {
      expect(out).toContain('Response verify OK');
      expect(out).toContain('real-leaf.crt: revoked');
      expect(out).toContain('Reason: superseded');
    });
  });

  it('le simulateur relit la demande et la réponse qu\'il a écrites, texte identique à openssl', async () => {
    const lab = await simulatedAuthority('T');
    await lab.srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -reqout /tmp/q.der`);
    const request = exportBinary(lab.srv, '/tmp/q.der', 'sim-nonce.req');
    const oracle = real('ocsp', '-reqin', request, '-text', '-noverify').stdout.split('OCSP Response')[0].trim();
    const shown = (await lab.srv.executeCommand('openssl ocsp -reqin /tmp/q.der -req_text -noverify 2>&1')).trim();
    expect(shown.startsWith(oracle)).toBe(true);
    expect(oracle).toContain('OCSP Nonce');
  });
});
