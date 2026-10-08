/*
 * Le client SSH synchrone n'offrait qu'UNE identite, la premiere trouvee.
 *
 * Mesure de depart : un poste porte `~/.ssh/id_rsa` et `~/.ssh/id_ed25519` ; seule la seconde est
 * dans `authorized_keys` du serveur (`ssh-copy-id -i ~/.ssh/id_ed25519.pub`). La commande
 * `ssh -o PasswordAuthentication=no netadmin@serveur hostname` repondait `Permission denied
 * (publickey,password)` alors que le journal du serveur montrait `Failed publickey` (la cle RSA) puis
 * `Accepted publickey` (la cle ed25519) : le canal avait reussi, mais la decision du client
 * synchrone, prise AVANT, n'avait regarde que id_rsa. Un client OpenSSH offre toutes les identites
 * dans l'ordre et s'arrete a la premiere que le serveur admet ; `-i` peut aussi etre repete.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : 2 des 4 cas tombent. Les deux
 * autres sont nommes : le TEMOIN (`-i` sur la seule cle admise marchait deja) et le refus d'une
 * identite unique non admise, qui doit rester un refus et que l'ancien code refusait deja.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let pc: Cli;
let server: Cli;

const SERVER_IP = '10.0.0.12';
const target = `-o PasswordAuthentication=no -o StrictHostKeyChecking=no ${ADMIN}@${SERVER_IP} hostname`;

beforeEach(async () => {
  const lab = await buildMatrixLab(['linux-pc', 'linux-server']);
  [pc, server] = lab.nodes.map((n) => n.device as unknown as Cli);
  await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  await pc.executeCommand('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa');
  await pc.executeCommand(`ssh-copy-id -i ~/.ssh/id_ed25519.pub ${ADMIN}@${SERVER_IP}`, `${SECRET}\n`);
});

describe('un poste qui porte deux identites', () => {
  it('temoin : -i sur la seule cle admise ouvre la session', async () => {
    expect(await pc.executeCommand(`ssh -i ~/.ssh/id_ed25519 ${target}`)).toContain('lsrv');
  });

  it('sans -i, la deuxieme identite est offerte apres le refus de la premiere', async () => {
    expect(await pc.executeCommand(`ssh ${target}`)).toContain('lsrv');
    expect(await server.executeCommand('sudo tail -30 /var/log/auth.log')).toMatch(/Failed publickey[\s\S]*Accepted publickey/);
  });

  it('-i repete : la cle refusee est offerte la premiere, la bonne ensuite', async () => {
    expect(await pc.executeCommand(`ssh -i ~/.ssh/id_rsa -i ~/.ssh/id_ed25519 ${target}`)).toContain('lsrv');
  });

  it('une seule identite refusee reste refusee', async () => {
    expect(await pc.executeCommand(`ssh -i ~/.ssh/id_rsa ${target}`)).toMatch(/Permission denied/);
  });
});
