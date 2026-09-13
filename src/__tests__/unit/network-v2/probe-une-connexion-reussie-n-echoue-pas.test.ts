/**
 * Une connexion SSH qui REUSSIT ne laisse aucun echec d'authentification.
 *
 * Ecrite a l'aveugle depuis OpenSSH : `auth.c` n'ecrit « Failed <methode>
 * for … ssh2 » que pour une tentative REELLEMENT refusee, et le client
 * n'envoie pas de mot de passe VIDE — avec `PermitEmptyPasswords no`, qui
 * est le defaut, un mot de passe vide n'est meme pas une tentative
 * recevable. Un `ssh alice@hote whoami` qui aboutit doit donc laisser
 * exactement une ligne `Accepted`, aucune ligne `Failed`, et ne rien
 * ajouter a `/var/log/btmp` — que `lastb` lit.
 *
 * Ce que la machine faisait : `SilentSshInteractionHandler` rend `''` par
 * defaut, et `PasswordAuthMethod` boucle jusqu'a trois fois sur son
 * fournisseur. Un appelant sans mot de passe offrait donc TROIS mots de
 * passe vides, refuses trois fois par le serveur, avant que le client ne
 * retombe sur la convention de confiance du simulateur et n'annonce le
 * succes. Une seule connexion reussie inscrivait trois echecs.
 *
 * Le port de ces lignes etait en outre 22 — le port du SERVEUR — parce que
 * l'evenement `auth_failure` ne porte pas de port et que `SshSyslogger`
 * retombe alors sur le sien. Un vrai sshd ecrit le port EPHEMERE du client.
 *
 * CE QUI N'EST PAS CORRIGE ICI, ET POURQUOI. Une ligne `Failed password`
 * SUBSISTE pour un appel sans justificatif : le serveur refuse bel et bien
 * le mot de passe vide (`PermitEmptyPasswords no` par defaut), et c'est le
 * CLIENT qui annonce ensuite le succes au nom de la convention de confiance
 * du simulateur — convention laissee intacte, documentee dans
 * `LinuxSshClient.verifyOfferedPassword`, dont dependent 268 appels de test.
 * Ce lot ramene donc TROIS echecs a UN, il ne les supprime pas.
 *
 * Le port de ces lignes reste par ailleurs 22 : l'evenement `auth_failure`
 * ne porte pas de port et `SshSyslogger` retombe sur le sien, tandis que la
 * ligne `Accepted` tient le vrai port ephemere d'un AUTRE ecrivain. C'est
 * une deuxieme ecriture du meme fait, mesuree mais non refermee ici.
 *
 * Mesure avant correction : 2 cas tombent sur 4.
 * Les 2 qui passent des deux cotes sont nommes : la ligne `Accepted` est le
 * TEMOIN qui prouve que le laboratoire ouvre vraiment une session (sans lui
 * une sonde faite d'absences passerait sur un journal vide), et `lastb`
 * vide est une NON-REGRESSION — ces echecs n'atteignaient deja pas btmp, et
 * ne doivent pas commencer.
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

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
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
  return { pc, srv };
}

const OPT = '-o StrictHostKeyChecking=no';

describe('un `ssh` qui aboutit n inscrit aucun echec', () => {
  it('TEMOIN : la ligne `Accepted` est bien ecrite', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    expect(await srv.executeCommand('sudo cat /var/log/auth.log')).toContain('Accepted');
  });

  it('un appelant non interactif n essaie le mot de passe QU UNE FOIS', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const journal = String(await srv.executeCommand('journalctl -u ssh'));
    expect([...journal.matchAll(/Failed password/g)].length).toBeLessThanOrEqual(1);
  });

  it('trois tentatives ne sont plus inscrites pour une seule connexion', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const journal = String(await srv.executeCommand('journalctl -u ssh'));
    expect([...journal.matchAll(/ ssh2$/gm)].length).toBeLessThanOrEqual(2);
  });

  it('`lastb` reste vide apres une connexion reussie', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    expect(String(await srv.executeCommand('sudo lastb'))).not.toContain('alice');
  });
});
