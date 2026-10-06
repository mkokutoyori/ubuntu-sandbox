/**
 * `openssl ca` sans -batch demande « Sign the certificate? [y/n]: » puis
 * « 1 out of 1 certificate requests certified, commit? [y/n] » et lit ses réponses sur l'entrée
 * standard (apps/ca.c, OpenSSL 3.0.13) ; sans réponse : « … WILL NOT BE CERTIFIED: I/O error ».
 * La trace complète (configuration, DN de la politique, date, « Database updated ») est comparée
 * octet pour octet à celle d'un openssl réel qui reçoit les mêmes réponses (la ligne de
 * configuration et la date, qui dépendent de la machine, sont normalisées).
 *
 * MESURÉ avant correctif : la trace affichait « commit? [y/n]y » sans rien demander, écrivait
 * « Data Base Updated » (1.1.1) et signait toujours, même sans réponse ; ni le DN, ni la durée en
 * jours n'étaient affichés. Avant correctif, 6 des 7 cas tombent ; le témoin (-batch avec la
 * signature réellement écrite dans l'index) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { play } from './_opensslPlan';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const CA = '/etc/ssl/CA';

function normalize(text: string): string {
  return text
    .replace(/^Using configuration from .*$/m, 'Using configuration from CONFIG')
    .replace(/until [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4} GMT/, 'until DATE');
}

function realRun(answers: string, flags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'realca-'));
  mkdirSync(join(dir, 'newcerts'));
  writeFileSync(join(dir, 'index.txt'), '');
  writeFileSync(join(dir, 'serial'), '1000\n');
  writeFileSync(join(dir, 'ca.cnf'), `[ca]\ndefault_ca=d\n[d]\ndir=${dir}\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/newcerts\nserial=$dir/serial\ndefault_md=sha256\npolicy=p\ndefault_days=30\n[p]\ncommonName=supplied\norganizationName=optional\ncountryName=optional\n[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Real CA\n`);
  const run = (args: string[], input = ''): string => {
    const r = spawnSync('openssl', args, { cwd: dir, input, encoding: 'utf8' });
    return r.stdout + r.stderr;
  };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-config', 'ca.cnf', '-days', '365']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'l.key', '-out', 'l.csr', '-subj', '/C=FR/O=Lab/CN=www.lab']);
  return run(['ca', '-config', 'ca.cnf', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-in', 'l.csr', '-out', 'l.crt', ...flags], answers);
}

async function simulatedRun(answers: string, flags: string): Promise<{ srv: LinuxServer; text: string }> {
  const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
  const sh = (c: string): Promise<string> => srv.executeCommand(c);
  await sh(`mkdir -p ${CA}`);
  await sh(`openssl req -x509 -newkey rsa:1024 -nodes -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -subj "/CN=Real CA"`);
  await sh('openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/l.key -out /tmp/l.csr -subj "/C=FR/O=Lab/CN=www.lab"');
  const text = await sh(`sh -c "printf '${answers}' | openssl ca -config ca.cnf -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/l.csr -out /tmp/l.crt -days 30 ${flags} 2>&1"`);
  return { srv, text };
}

describe('openssl ca : confirmations', () => {
  it('témoin : -batch signe et inscrit le certificat à l\'index', async () => {
    const { srv } = await simulatedRun('', '-batch');
    expect(await srv.executeCommand(`cat ${CA}/index.txt`)).toMatch(/^V\t.*\t1000\tunknown\t\/C=FR\/O=Lab\/CN=www\.lab$/m);
  });

  it('oui puis oui : trace identique à openssl réel', async () => {
    expect(normalize((await simulatedRun('y\\ny\\n', '')).text)).toBe(normalize(realRun('y\ny\n', ['-days', '30'])).trimEnd());
  });

  it('-batch : trace identique à openssl réel', async () => {
    expect(normalize((await simulatedRun('', '-batch')).text)).toBe(normalize(realRun('', ['-days', '30', '-batch'])).trimEnd());
  });

  it('non à la signature : « CERTIFICATE WILL NOT BE CERTIFIED », rien n\'est inscrit', async () => {
    const { srv, text } = await simulatedRun('n\\n', '');
    expect(normalize(text)).toBe(normalize(realRun('n\n', ['-days', '30'])).trimEnd());
    expect(await srv.executeCommand(`cat ${CA}/index.txt`)).not.toMatch(/1000\tunknown/);
  });

  it('oui puis non au commit : « CERTIFICATION CANCELED », rien n\'est inscrit', async () => {
    const { srv, text } = await simulatedRun('y\\nn\\n', '');
    expect(normalize(text)).toBe(normalize(realRun('y\nn\n', ['-days', '30'])).trimEnd());
    expect(await srv.executeCommand('cat /tmp/l.crt')).toContain('No such file');
  });

  it('aucune réponse : « I/O error », comme openssl réel', async () => {
    const { text } = await simulatedRun('', '');
    expect(normalize(text)).toBe(normalize(realRun('', ['-days', '30'])).trimEnd());
  });

  it('dans un plan interactif : en-tête, deux invites, puis l\'écriture de la base', async () => {
    const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
    await srv.executeCommand(`mkdir -p ${CA}`);
    await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -nodes -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -subj "/CN=Real CA"`);
    await srv.executeCommand('openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/l.key -out /tmp/l.csr -subj "/CN=www.lab"');
    const played = await play(srv, `openssl ca -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/l.csr -out /tmp/l.crt -days 30`, ['y', 'y']);
    expect(played?.prompts).toEqual(['Sign the certificate? [y/n]:', '1 out of 1 certificate requests certified, commit? [y/n]']);
    expect(played?.output.join('\n')).toContain('Certificate is to be certified until');
    expect(played?.output.join('\n')).toContain('Database updated');
    expect(await srv.executeCommand('openssl x509 -in /tmp/l.crt -noout -subject')).toContain('CN = www.lab');
  });
});
