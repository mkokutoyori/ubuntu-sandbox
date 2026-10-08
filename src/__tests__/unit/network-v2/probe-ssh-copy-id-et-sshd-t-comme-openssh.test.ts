/*
 * Mesure de depart, deux ecarts avec OpenSSH 8.9 sur Ubuntu 22.04 :
 *  - `sshd -T` et `sshd -t` s'executaient sans privilege ; un utilisateur ordinaire obtient
 *    `sshd: no hostkeys available -- exiting.` (les cles d'hote sont root:root 0600), apres le controle
 *    de syntaxe de la configuration, qui lui passe avant ;
 *  - `ssh-copy-id` sans `-i` prenait ed25519, puis rsa, puis ecdsa dans cet ordre ; le script d'OpenSSH
 *    prend le fichier `~/.ssh/id*.pub` le plus RECENT (`ls -t`), certificats exclus.
 * Un troisieme ecart, la commande `:!cmd` de vim qui ignorait l'identite de la session de l'editeur, est
 * mesure par vim-system-config-filetype (sshd -t -f % sous root), rendu rouge par le premier correctif.
 * Sans correctif : 3 cas sur 6 tombent (sshd -T et -t sans privilege, cle la plus recente, certificat
 * ignore : le premier cas groupe les deux commandes) ; les 3 temoins qui passent dans les deux etats :
 * sshd -T sous root, erreur de syntaxe rapportee avant l'absence de cle, ssh-copy-id avec -i explicite.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, type MatrixLab, type Node } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let lab: MatrixLab;
const node = (kind: string): Node => lab.nodes.find((n) => n.kind === kind)!;
const cli = (kind: string): Cli => node(kind).device as unknown as Cli;

beforeAll(async () => { lab = await buildMatrixLab(['linux-pc', 'linux-server']); }, 120000);

describe('sshd -T / -t sans privilege', () => {
  it('temoin : root obtient la configuration effective', async () => {
    expect(await cli('linux-server').executeCommand('sudo sshd -T')).toContain('port 22');
  });

  it('un utilisateur ordinaire obtient « no hostkeys available »', async () => {
    expect(await cli('linux-pc').executeCommand('sshd -T')).toContain('sshd: no hostkeys available -- exiting.');
    expect(await cli('linux-pc').executeCommand('sshd -t')).toContain('sshd: no hostkeys available -- exiting.');
  });

  it('temoin : une erreur de syntaxe est rapportee avant l\'absence de cle', async () => {
    await cli('linux-pc').executeCommand('echo "Zorglub yes" > /tmp/bad_sshd_config');
    const out = await cli('linux-pc').executeCommand('sshd -t -f /tmp/bad_sshd_config');
    expect(out).toContain('Bad configuration option');
    expect(out).not.toContain('no hostkeys');
  });
});

describe('ssh-copy-id sans -i', () => {
  const copyId = (extra = '') => cli('linux-pc').executeCommand(`ssh-copy-id ${extra} ${ADMIN}@${node('linux-server').ip}`, `${SECRET}\n`);
  beforeEach(async () => {
    await cli('linux-pc').executeCommand('rm -f ~/.ssh/id_*');
    await cli('linux-pc').executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
    await cli('linux-pc').executeCommand('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa');
  });

  it('prend la cle publique la plus recente, pas la premiere de la liste', async () => {
    await cli('linux-pc').executeCommand('touch -d "2020-01-01" ~/.ssh/id_ed25519.pub');
    const out = await copyId();
    expect(out).toContain('id_rsa.pub');
    expect(out).not.toContain('id_ed25519.pub');
  });

  it('ignore les certificats', async () => {
    await cli('linux-pc').executeCommand('cp ~/.ssh/id_rsa.pub ~/.ssh/id_rsa-cert.pub');
    await cli('linux-pc').executeCommand('touch ~/.ssh/id_rsa-cert.pub');
    const out = await copyId();
    expect(out).toContain('id_rsa.pub');
    expect(out).not.toContain('-cert.pub');
  });

  it('temoin : -i explicite designe ce fichier', async () => {
    expect(await copyId('-i ~/.ssh/id_ed25519.pub')).toContain('id_ed25519.pub');
  });
});
