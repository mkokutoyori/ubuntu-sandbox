/*
 * Mesure de depart : `ip ssh pubkey-chain` etait refuse par IOS (`% Invalid input`) sur routeur et
 * commutateur, et le serveur SSH IOS n'annoncait que `password` : une cle publique n'ouvrait jamais
 * de session. Source : transcriptions publiees de configurations IOS (networklessons, NSRC,
 * ciscozine, hubbardonnetworking) — la page officielle Cisco n'est pas joignable depuis ici (le
 * mandataire de sortie refuse cisco.com) ; le format du message d'erreur sur cle illisible n'est
 * donc PAS atteste et ce sondage ne l'epingle pas.
 * Sans correctif : 8 cas sur 16 tombent (4 par plateforme : la cle coupee en lignes, la running-config,
 * `key-hash` direct, `key-hash` mal forme). Les 8 qui passent dans les deux etats sont des temoins :
 * « le mot de passe ouvre toujours la session » (le laboratoire est sain), « sans cle declaree la cle est
 * refusee », « la cle d'un autre poste est refusee » (echec ferme) et « une cle illisible ne stocke rien »
 * (avant le correctif la commande entiere est refusee, apres elle est lue puis rejetee : le resultat
 * observable est le meme).
 * Criteres : le hachage stocke est le MD5 du blob de cle (32 hexa majuscules), `key-string`
 * accepte la cle coupee en lignes, la running-config affiche `key-hash` et jamais la cle, et
 * l'authentification par cle ne dispense pas du compte local.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, type MatrixLab, type Node } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string): Promise<string> }

let lab: MatrixLab;
const node = (kind: string): Node => lab.nodes.find((n) => n.kind === kind)!;
const cli = (kind: string): Cli => node(kind).device as unknown as Cli;

const wrap = (text: string, width = 64): string[] => text.match(new RegExp(`.{1,${width}}`, 'g')) ?? [];

async function keyBody(owner: string, file: string): Promise<{ body: string; comment: string }> {
  const [, body, comment] = (await cli(owner).executeCommand(`cat ${file}`)).trim().split(/\s+/);
  return { body, comment };
}

beforeAll(async () => {
  lab = await buildMatrixLab(['linux-pc', 'linux-server', 'router-cisco', 'switch-cisco']);
  await cli('linux-pc').executeCommand('ssh-keygen -t rsa -b 2048 -N "" -f ~/.ssh/id_rsa');
  await cli('linux-server').executeCommand('ssh-keygen -t rsa -b 2048 -N "" -f ~/.ssh/id_rsa');
}, 120000);

const installKey = async (kind: string, user: string, body: string): Promise<string> => {
  let last = '';
  for (const line of ['enable', 'configure terminal', 'ip ssh pubkey-chain', `username ${user}`, 'key-string',
    ...wrap(body), 'exit', 'exit', 'exit', 'end']) last = await cli(kind).executeCommand(line);
  return last;
};

const byKey = (kind: string, from = 'linux-pc') => cli(from).executeCommand(
  `ssh -i ~/.ssh/id_rsa -o PasswordAuthentication=no -o PreferredAuthentications=publickey -o StrictHostKeyChecking=no `
  + `-o ConnectTimeout=3 ${ADMIN}@${node(kind).ip} "show clock"`);

describe.each(['router-cisco', 'switch-cisco'])('ip ssh pubkey-chain sur %s', (kind) => {
  it('temoin : le mot de passe ouvre la session', async () => {
    expect(await cli('linux-pc').executeCommand(
      `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no ${ADMIN}@${node(kind).ip} "show clock"`)).toMatch(/\d\d:\d\d:\d\d/);
  });

  it('sans cle declaree, la cle est refusee', async () => {
    expect(await byKey(kind)).toContain('Permission denied');
  });

  it('key-string coupee en lignes : la cle ouvre la session sans mot de passe', async () => {
    const { body } = await keyBody('linux-pc', '~/.ssh/id_rsa.pub');
    await installKey(kind, ADMIN, body);
    expect(await byKey(kind)).toMatch(/\d\d:\d\d:\d\d/);
  });

  it('la running-config montre key-hash, jamais la cle', async () => {
    const config = await cli(kind).executeCommand('show running-config | begin pubkey');
    expect(config).toMatch(/ip ssh pubkey-chain\n\s+username netadmin\n\s+key-hash ssh-rsa [0-9A-F]{32}/);
    expect(config).not.toContain('AAAAB3NzaC1yc2E');
  });

  it('la cle d\'un autre poste est refusee', async () => {
    expect(await byKey(kind, 'linux-server')).toContain('Permission denied');
  });

  it('key-hash saisi directement equivaut a key-string', async () => {
    const hashLine = (await cli(kind).executeCommand('show running-config | include key-hash')).trim();
    const hash = /ssh-rsa ([0-9A-F]{32})/.exec(hashLine)![1];
    for (const line of ['configure terminal', 'ip ssh pubkey-chain', `no username ${ADMIN}`, 'end']) await cli(kind).executeCommand(line);
    expect(await byKey(kind)).toContain('Permission denied');
    for (const line of ['configure terminal', 'ip ssh pubkey-chain', `username ${ADMIN}`, `key-hash ssh-rsa ${hash}`, 'end']) {
      await cli(kind).executeCommand(line);
    }
    expect(await byKey(kind)).toMatch(/\d\d:\d\d:\d\d/);
  });

  it('un key-hash mal forme est refuse et ne stocke rien', async () => {
    for (const line of ['configure terminal', 'ip ssh pubkey-chain', `no username ${ADMIN}`, `username ${ADMIN}`]) await cli(kind).executeCommand(line);
    const refused = await cli(kind).executeCommand('key-hash ssh-rsa NOT-A-HASH');
    await cli(kind).executeCommand('end');
    expect(refused).toMatch(/^%/);
    expect(await byKey(kind)).toContain('Permission denied');
  });

  it('une cle illisible est refusee sans rien stocker', async () => {
    const out = await installKey(kind, ADMIN, 'AAAAnotakey');
    expect(out).toBe('');
    expect(await byKey(kind)).toContain('Permission denied');
  });
});
