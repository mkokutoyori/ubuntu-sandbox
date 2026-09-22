/*
 * Un `ssh hote commande` SANS justificatif n'ouvre aucun canal d'exec.
 *
 * CETTE SONDE REMPLACE `probe-ssh-sans-justificatif-passe-sur-le-fil`,
 * QUI EPINGLAIT LE DEFAUT COMME UN CONTRAT. Elle affirmait, et
 * verifiait, qu'un appel sans justificatif « coute AUTANT de trames
 * qu'une connexion authentifiee » — c'est-a-dire que le serveur lui
 * ouvrait son canal. La RFC 4252 §5.2 dit le contraire, et en toutes
 * lettres : « The server MUST always reject this request, unless the
 * client is to be granted access without any authentication, in which
 * case, the server MUST accept this request. » Le lot precedent a ferme
 * le fail-open ; la sonde qui le decrivait devait tomber avec lui plutot
 * que d'etre « reparee » en rendant le simulateur a nouveau permissif.
 * Ce qui est GARDE d'elle est sa methode, et c'est le plus precieux :
 * compter les trames du port du client, et lire la DIFFERENCE entre deux
 * echanges du meme laboratoire.
 *
 * MESURE, sur le meme laboratoire tire trois fois :
 *
 *     sans justificatif         12 trames   « Permission denied »
 *     MAUVAIS mot de passe      12 trames   « Permission denied »
 *     BON mot de passe          13 trames   rend « alice »
 *
 * Les deux premiers comptes sont EGAUX, et c'est la demonstration : un
 * appel sans justificatif coute exactement ce que coute un refus, donc
 * il est refuse au meme endroit, par le meme serveur, sur le meme fil.
 * La treizieme trame du troisieme cas est le canal d'exec, celui que
 * seule une authentification reussie ouvre. La taille de la sortie ne
 * change pas ces comptes — la difference est le CANAL, pas la charge
 * utile, exactement la discrimination que la regle 4 demande.
 *
 * Et la comptabilite de session suit le meme verdict : `who` ne montre
 * pas de session pour l'appel refuse, et en montre une pour l'appel
 * authentifie. Une session inscrite sans justificatif serait la meme
 * permissivite, ecrite ailleurs.
 *
 * Ecrite contre la RFC 4252 §5.2, norme ouverte adoptee et neutre vis
 * a vis des constructeurs — c'est bien elle qui fait autorite ici, et
 * non la documentation d'un vendeur.
 *
 * Discriminee contre l'etat d'avant le lot RFC (`git stash`) : les trois
 * cas de refus tombent, puisque le serveur repondait alors. Les 3 autres
 * sont nommes ici :
 *
 *  - TEMOIN DU BON MOT DE PASSE : il rend « alice » des deux cotes, et
 *    c'est lui qui distingue « le serveur refuse tout » de « le serveur
 *    refuse ce qui n'est pas authentifie ».
 *  - TEMOIN DU MAUVAIS MOT DE PASSE : il etait deja refuse. Il garde la
 *    porte fermee sur une sonde qui ne verifierait que des succes.
 *  - TEMOIN DE LA COMPTABILITE : une session authentifiee EST inscrite
 *    dans `who`. Sans lui, « aucune session pour l'appel refuse » et
 *    « ce simulateur n'inscrit aucune session » seraient indiscernables.
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
const SECRET = 'secret123';

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
  await srv.executeCommand(`echo "alice:${SECRET}" | sudo chpasswd`);
  const port = pc.getPorts()[0];
  return { pc, srv, trames: () => port.getCounters().framesOut };
}

async function cout(ligne: string): Promise<number> {
  const lab = await labo();
  const avant = lab.trames();
  await lab.pc.executeCommand(ligne);
  return lab.trames() - avant;
}

describe('le laboratoire authentifie vraiment — les TEMOINS', () => {
  it('le BON mot de passe rend la sortie de la commande', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand(
      `sshpass -p ${SECRET} ssh ${OPT} alice@10.0.0.2 whoami`)).toContain('alice');
  });

  it('un MAUVAIS mot de passe reste refuse', async () => {
    const { pc } = await labo();

    const out = await pc.executeCommand(
      `sshpass -p MAUVAIS ssh ${OPT} alice@10.0.0.2 whoami`);
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('alice\n');
  });
});

describe('un appel sans justificatif est refuse comme un mauvais mot de passe', () => {
  it('il rend le meme refus', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`))
      .toContain('Permission denied');
  });

  it('il coute AUTANT de trames qu une authentification qui echoue', async () => {
    const sansJustificatif = await cout(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const mauvaisMotDePasse = await cout(
      `sshpass -p MAUVAIS ssh ${OPT} alice@10.0.0.2 whoami`);

    expect(sansJustificatif).toBe(mauvaisMotDePasse);
  });

  it('et MOINS qu une connexion authentifiee, qui ouvre son canal d exec', async () => {
    const sansJustificatif = await cout(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const authentifie = await cout(
      `sshpass -p ${SECRET} ssh ${OPT} alice@10.0.0.2 whoami`);

    expect(authentifie).toBeGreaterThan(sansJustificatif);
  });
});

describe('la comptabilite de session suit le meme verdict', () => {
  it('une session authentifiee est INSCRITE — le TEMOIN', async () => {
    const { pc, srv } = await labo();

    await pc.executeCommand(`sshpass -p ${SECRET} ssh ${OPT} alice@10.0.0.2 sleep 60`);

    const who = String(await srv.executeCommand('who'));
    expect(who).toMatch(/alice\s+pts\/\d+/);
    expect(who).toContain('10.0.0.1');
  });

  it('un appel refuse n inscrit rien', async () => {
    const { pc, srv } = await labo();

    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 sleep 60`);

    expect(String(await srv.executeCommand('who'))).not.toMatch(/alice\s+pts/);
  });
});
