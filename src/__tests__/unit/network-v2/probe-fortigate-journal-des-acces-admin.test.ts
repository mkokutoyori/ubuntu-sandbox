/*
 * Un FortiGate ne journalisait pas qui s'etait connecte en administration.
 *
 * Mesure de depart : trois connexions SSH (mot de passe faux, compte inexistant, connexion reussie)
 * puis `execute log filter category 1` / `execute log display` ne rendaient que les « Object attribute
 * configured » de la configuration : aucune trace de l'acces lui-meme. C'est la premiere piece qu'un
 * auditeur reclame sur un pare-feu : qui est entre, d'ou, quand, et qui a essaye sans y parvenir.
 *
 * Corrige : le journal d'evenements recoit « Admin login successful » (0100032001), « Admin login
 * failed » (0100032002, raison `passwd_invalid` pour un compte connu, `name_invalid` sinon) et
 * « Admin logout successful » (0100032003), avec l'interface d'administration `ssh(10.0.0.11)`, la
 * source, la destination et le profil.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : tous les cas tombent sauf le TEMOIN
 * (les changements de configuration sont deja journalises).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, Console } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let pc: Cli;
let firewall: Cli;

const ssh = (user: string, secret: string) =>
  pc.executeCommand(`sshpass -p ${secret} ssh -o StrictHostKeyChecking=no ${user}@10.0.0.12 "get system status"`);

const eventLog = async (): Promise<string> => {
  await firewall.executeCommand('execute log filter category 1');
  return firewall.executeCommand('execute log display');
};

beforeEach(async () => {
  const lab = await buildMatrixLab(['linux-pc', 'firewall-fortinet']);
  [pc, firewall] = lab.nodes.map((n) => n.device as unknown as Cli);
});

describe('journal des evenements', () => {
  it('temoin : un changement de configuration est journalise', async () => {
    expect(await eventLog()).toContain('logdesc="Object attribute configured"');
  });

  it('une connexion reussie laisse « Admin login successful »', async () => {
    await ssh(ADMIN, SECRET);
    const log = await eventLog();
    expect(log).toContain('logid="0100032001"');
    expect(log).toContain('logdesc="Admin login successful"');
    expect(log).toContain('user="netadmin" ui="ssh(10.0.0.11)" method="ssh" srcip=10.0.0.11 dstip=10.0.0.12');
    expect(log).toContain('status="success" reason="none" profile="super_admin"');
  });

  it('un mot de passe faux laisse « Admin login failed » / passwd_invalid, au niveau alert', async () => {
    await ssh(ADMIN, 'wrong');
    const log = await eventLog();
    expect(log).toContain('logid="0100032002"');
    expect(log).toContain('level="alert"');
    expect(log).toContain('status="failed" reason="passwd_invalid"');
    expect(log).toContain('Administrator netadmin login failed from ssh(10.0.0.11) because of invalid password');
  });

  it('un compte inexistant laisse la raison name_invalid', async () => {
    await ssh('ghost', SECRET);
    const log = await eventLog();
    expect(log).toContain('user="ghost"');
    expect(log).toContain('reason="name_invalid"');
  });

  it('la deconnexion d\'une session ouverte est journalisee', async () => {
    const session = await Console.open(pc as never);
    await session.login(`ssh ${ADMIN}@10.0.0.12`, SECRET, ADMIN);
    await session.type('exit');
    expect(await eventLog()).toContain('logdesc="Admin logout successful"');
  });
});
