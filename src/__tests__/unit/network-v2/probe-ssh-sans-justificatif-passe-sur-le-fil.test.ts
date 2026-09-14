/**
 * Un `ssh hote commande` SANS justificatif passe sur le FIL, il ne repond
 * pas depuis la memoire.
 *
 * MESURE DE DEPART, en comptant les trames emises par le port du client.
 * Le meme laboratoire, trois fois :
 *
 *     sans justificatif         14 trames   rend « alice »
 *     MAUVAIS mot de passe      14 trames   rend « Permission denied »
 *     BON mot de passe          15 trames   rend « alice »
 *
 * L'appel sans justificatif coutait exactement ce que coute un echec
 * d'authentification, et rendait pourtant la sortie de la commande. La
 * quinzieme trame est le canal d'exec : il n'etait jamais ouvert. La taille
 * de la sortie ne change pas ces comptes, donc la difference est bien le
 * canal et non la charge utile. C'est l'exemple meme que la regle 4 cite.
 *
 * CAUSE. Le client court-circuitait : il offrait un mot de passe VIDE, le
 * serveur le refusait a juste titre (`PermitEmptyPasswords no` par defaut),
 * `openWireSshSession` jetait la session perdue, et l'exec retombait sur le
 * chemin en memoire pendant que le client annoncait quand meme le succes au
 * nom de la convention de confiance du simulateur.
 *
 * CORRECTION, en deux moities qui ne valent que l'une par l'autre.
 *   1. Le client OMET le champ mot de passe quand il n'en a aucun — ce qui
 *      est distinct d'en offrir un vide, que les tests `PermitEmptyPasswords`
 *      fournissent legitimement. Le serveur tranche alors lui-meme, par
 *      `acceptsWithoutCredential`, toujours soumis a `AllowUsers`, a
 *      `PasswordAuthentication`, a l'existence du compte et au verrouillage
 *      faillock.
 *   2. `recordSshLogin` portait DEUX metiers : emettre la ligne du journal
 *      ET ouvrir la session (table des sessions, noeud pts, lastlog, logind,
 *      processus sshd/bash). Le chemin du fil sautait l'appel entier, donc
 *      la session n'existait pas : `who`, `w`, `last`, `lastlog` et logind
 *      tombaient tous. Les deux metiers sont separes ;
 *      `openSshSessionRecord` porte la comptabilite, et les deux chemins
 *      l'appellent.
 *
 * Mesure avant correction : 2 cas sur 4 tombent — les deux comptes de trames.
 * Les 2 qui passent des deux cotes sont nommes, et le second est le plus
 * important des quatre :
 *   - « un MAUVAIS mot de passe reste refuse » est le TEMOIN : sans lui, une
 *     sonde qui ne verifie que des succes ne prouverait pas que le verrou
 *     tient encore ;
 *   - « la session est INSCRITE » passe DEJA, parce que le chemin en memoire
 *     appelait `recordSshLogin` qui ouvrait la session. Il est ici en
 *     NON-REGRESSION, et c'est exactement le cas qui a fait echouer une
 *     premiere tentative de ce correctif : en deplacant l'authentification
 *     sur le fil sans separer les deux metiers de `recordSshLogin`, la
 *     session cessait d'exister et dix fichiers tombaient — `who`, `w`,
 *     `last`, `lastlog`, logind, liaison des processus. Ce cas garde la
 *     porte fermee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const OPT = '-o StrictHostKeyChecking=no';

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer; trames: () => number }> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
  const m = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  const port = pc.getPorts()[0];
  return { pc, srv, trames: () => port.getCounters().framesOut };
}

describe('un ssh sans justificatif ouvre vraiment son canal d exec', () => {
  it('TEMOIN : un MAUVAIS mot de passe reste refuse', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(
      `sshpass -p MAUVAIS ssh ${OPT} alice@10.0.0.2 whoami`);
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('alice\n');
  });

  it('il coute AUTANT de trames qu une connexion authentifiee', async () => {
    const sansJustificatif = await labo();
    const avant = sansJustificatif.trames();
    await sansJustificatif.pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const coutSansJustificatif = sansJustificatif.trames() - avant;

    const avecMotDePasse = await labo();
    const avant2 = avecMotDePasse.trames();
    await avecMotDePasse.pc.executeCommand(
      `sshpass -p secret123 ssh ${OPT} alice@10.0.0.2 whoami`);
    const coutAuthentifie = avecMotDePasse.trames() - avant2;

    expect(coutSansJustificatif).toBe(coutAuthentifie);
  });

  it('il coute PLUS qu une authentification qui echoue', async () => {
    const reussi = await labo();
    const a1 = reussi.trames();
    await reussi.pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const coutReussi = reussi.trames() - a1;

    const echoue = await labo();
    const a2 = echoue.trames();
    await echoue.pc.executeCommand(`sshpass -p MAUVAIS ssh ${OPT} alice@10.0.0.2 whoami`);
    const coutEchoue = echoue.trames() - a2;

    expect(coutReussi).toBeGreaterThan(coutEchoue);
  });

  it('la session est INSCRITE : `who` montre le compte et son adresse', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 sleep 60`);
    const who = String(await srv.executeCommand('who'));
    expect(who).toMatch(/alice\s+pts\/\d+/);
    expect(who).toContain('10.0.0.1');
  });
});
