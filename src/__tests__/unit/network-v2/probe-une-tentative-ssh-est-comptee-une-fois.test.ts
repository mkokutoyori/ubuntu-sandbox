/*
 * Une tentative SSH refusee etait comptee TROIS fois par le routeur.
 *
 * L'AUTORITE est Cisco, Login Enhancements : `login block-for <s>
 * attempts <n> within <s>` compte des TENTATIVES de connexion echouees,
 * `show login` rend « Login failures for current window », `show login
 * failures` une colonne `Count` par couple utilisateur/source, et
 * `login on-failure log` une ligne `%SEC_LOGIN-4-LOGIN_FAILED` par echec.
 * Quatre vues d'un meme compteur : une tentative, un echec.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le chemin.
 *
 * Mesure de depart, sur un R1 arme de `login on-failure log`, apres UNE
 * seule tentative au mauvais mot de passe depuis un poste Linux :
 *
 *   show logging         3 x %SEC_LOGIN-4-LOGIN_FAILED
 *                          [Reason: bad password]
 *                          [Reason: authentication failed]
 *                          [Reason: bad password]
 *
 * LA CAUSE EST LE RACCOURCI QUE LA REGLE 4 REFUSE. Le serveur SSH du
 * routeur tranche l'authentification SUR LE FIL et l'inscrit — c'est la
 * premiere ligne. Puis le CLIENT, ayant appris le refus
 * (`wireAuthRefused`), rejoue l'authentification EN MEMOIRE sur l'objet
 * du pair : `runCrossPlatformExec` appelle `sshHost.evaluate(request)`,
 * qui inscrit la seconde, puis `target.recordSshLogin(false)`, qui
 * inscrit la troisieme. Le chemin Linux voisin savait deja ne pas le
 * faire ; le chemin des pairs non-Linux, non.
 *
 * Le client ne rejoue plus rien : quand le fil a refuse, il rend le refus
 * et s'arrete. Le verdict et son inscription restent la ou le fil les a
 * mis, chez le serveur.
 *
 * LE RACCOURCI CACHAIT UN TROU DU SERVEUR, que son retrait a mis a nu.
 * Pour un utilisateur INCONNU, `SshServerHandler` emettait ses evenements
 * `auth_invalid_user` / `auth_failure` mais n'appelait pas
 * `ctx.recordAuthFailure` — seule branche d'echec a l'oublier, alors que
 * c'est, sur un routeur, l'unique chemin vers le magasin de comptes, le
 * bloqueur et le journal. Seul le rejeu en memoire inscrivait ces
 * tentatives ; le retirer seul aurait laisse passer sans trace une
 * attaque par dictionnaire — `login block-for` existe pour elle. Un
 * critere de securite doit echouer FERME : la branche inscrit desormais
 * l'echec comme ses voisines. C'est aussi ce que fait OpenSSH, dont
 * `auth_log` appelle `record_failed_login` pour un echec de mot de passe
 * quel que soit l'utilisateur, ce qui met les noms inconnus dans `btmp`.
 *
 * Discriminee contre TROIS etats (`git stash push`) :
 *
 *  - avant les deux correctifs : 5 des 8 cas tombent — les quatre vues
 *    du compteur, et « l'inconnu compte une fois » (il comptait deux) ;
 *    « deux noms au hasard ferment la porte » y passe, par exces de
 *    comptage ;
 *  - le correctif du client SEUL : 2 des 8 tombent, les deux cas de
 *    l'inconnu — c'est ce qui prouve que le correctif du serveur est
 *    requis et non accessoire ;
 *  - les deux : 8 sur 8.
 *
 * Les 2 cas qui passent partout sont nommes ici :
 *
 *  - TEMOIN DU LABORATOIRE : le bon secret ouvre la session des deux
 *    cotes. Sans lui, un refus pourrait venir d'un labo casse.
 *  - TEMOIN DU BLOCAGE : apres DEUX vraies tentatives, `login block-for`
 *    ferme la porte des deux cotes. Il prouve que le blocage fonctionne
 *    une fois le seuil vraiment atteint, donc que le cas « une tentative
 *    ne ferme pas la porte » mesure le COMPTE et non un blocage muet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ROUTER_IP = '10.0.0.6';
const HOST_IP = '10.0.0.1';
const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ r1: CiscoRouter; host: LinuxPC }> {
  const r1 = new CiscoRouter('R1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 4, 0, 0);
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);

  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    `username admin privilege 15 secret ${SECRET}`,
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'login on-failure log',
    'login block-for 60 attempts 2 within 60',
    'interface GigabitEthernet0/0',
    `ip address ${ROUTER_IP} 255.255.255.0`,
    'no shutdown', 'exit',
    'line vty 0 4', 'login local', 'transport input ssh', 'exit',
    'end',
  ]) await r1.executeCommand(c);

  await host.executeCommand(`ifconfig eth0 ${HOST_IP} netmask 255.255.255.0`);
  return { r1, host };
}

const wrongAttempt = (host: LinuxPC): Promise<string> =>
  host.executeCommand(
    `ssh -o NumberOfPasswordPrompts=1 admin@${ROUTER_IP} "show clock"`, 'faux\n');

const ghostAttempt = (host: LinuxPC): Promise<string> =>
  host.executeCommand(
    `ssh -o NumberOfPasswordPrompts=1 ghost@${ROUTER_IP} "show clock"`, `${SECRET}\n`);

const rightAttempt = (host: LinuxPC): Promise<string> =>
  host.executeCommand(`ssh admin@${ROUTER_IP} "show clock"`, `${SECRET}\n`);

describe('une tentative refusee, un echec — dans les quatre vues', () => {
  it('`show logging` porte UNE ligne %SEC_LOGIN-4-LOGIN_FAILED', async () => {
    const { r1, host } = await lab();
    await wrongAttempt(host);

    const log = await r1.executeCommand('show logging');
    expect(log.match(/%SEC_LOGIN-4-LOGIN_FAILED/g) ?? []).toHaveLength(1);
  });

  it('`show login failures` compte 1', async () => {
    const { r1, host } = await lab();
    await wrongAttempt(host);

    expect(await r1.executeCommand('show login failures'))
      .toMatch(new RegExp(`admin\\s+${HOST_IP.replace(/\./g, '\\.')}\\s+\\d+\\s+1\\s`));
  });

  it('`show login` compte 1 dans la fenetre courante', async () => {
    const { r1, host } = await lab();
    await wrongAttempt(host);

    expect(await r1.executeCommand('show login'))
      .toMatch(/Login failures for current window: 1\b/);
  });

  it('et `login block-for ... attempts 2` ne ferme pas la porte apres UNE tentative', async () => {
    const { host } = await lab();
    await wrongAttempt(host);

    expect(await rightAttempt(host)).not.toMatch(/refused|Quiet-Mode|denied/i);
  });
});

describe('un utilisateur INCONNU est une tentative comme une autre', () => {
  it('`show login failures` le compte, une fois', async () => {
    const { r1, host } = await lab();
    await ghostAttempt(host);

    expect(await r1.executeCommand('show login failures'))
      .toMatch(new RegExp(`ghost\\s+${HOST_IP.replace(/\./g, '\\.')}\\s+\\d+\\s+1\\s`));
  });

  it('et DEUX essais de noms au hasard ferment la porte — l\'attaque par dictionnaire', async () => {
    const { host } = await lab();
    await ghostAttempt(host);
    await ghostAttempt(host);

    expect(await rightAttempt(host)).toMatch(/Quiet-Mode/);
  });
});

describe('ce que le correctif ne doit pas emporter', () => {
  it('le bon secret ouvre la session — le TEMOIN du laboratoire', async () => {
    const { host } = await lab();

    expect(await rightAttempt(host)).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('DEUX vraies tentatives ferment la porte — le TEMOIN du blocage', async () => {
    const { host } = await lab();
    await wrongAttempt(host);
    await wrongAttempt(host);

    expect(await rightAttempt(host)).toMatch(/refused|Quiet-Mode/i);
  });
});
