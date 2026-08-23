/**
 * strongSwan — `ipsec` et `systemctl` lisent le MEME etat.
 *
 * Mesure de depart : `ipsec start` posait un drapeau porte par
 * l'executeur de commandes (`LinuxCommandExecutor.ipsecState`) et aucune
 * unite strongSwan n'existait dans le gestionnaire de services. Sur la
 * meme machine au meme instant, `ipsec status` annoncait donc un demon
 * qui tourne pendant que `systemctl status strongswan` repondait « Unit
 * strongswan.service could not be found » — deux vues qui ne pouvaient
 * pas se contredire puisqu'elles ne parlaient de rien de commun.
 *
 * Ce qui est ferme : l'unite est celle de strongSwan, attestee contre
 * `init/systemd-starter/strongswan-starter.service.in` du depot amont —
 * nom `strongswan-starter`, `ExecStart=/usr/sbin/ipsec start --nofork`,
 * `After=syslog.target network-online.target`, aucun `ExecReload`. Le
 * drapeau est supprime : `ipsec start|stop|restart` et la question « est-
 * ce que ca tourne ? » passent toutes par le gestionnaire, donc les deux
 * vues ne PEUVENT plus diverger. `strongswan` est resolu vers
 * `strongswan-starter` par la table d'alias qui porte deja
 * `chronyd`/`bind9`, cette image ne portant qu'un seul demon IPsec.
 *
 * Une consequence assumee et mesuree : l'unite est ENABLED par defaut,
 * comme apres un `apt install strongswan` sur Debian, donc le demon
 * tourne des le demarrage. Avant ce lot le binaire etait livre par
 * l'image et rien ne tournait — la machine portait strongSwan sans
 * strongSwan.
 *
 * Discrimine par `git stash` sur les quatre fichiers touches : 6 des 8
 * cas tombent. Les 2 qui passent des deux cotes sont nommes ici plutot
 * que laisses a decouvrir — « ipsec status apres ipsec start », qui etait
 * deja juste et sert de non-regression ; et « ipsec stop rend l unite
 * inactive », qui passait avant pour une raison qui ne prouve rien :
 * `systemctl is-active` d'une unite INEXISTANTE repond deja
 * « inactive ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

function poste(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'poste', 0, 0);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return pc;
}

describe('strongSwan : une machine, un seul etat de demon', () => {
  it('au demarrage les deux vues disent la meme chose', async () => {
    const pc = poste();
    expect(await pc.executeCommand('sudo ipsec status'))
      .toContain('Security Associations (0 up, 0 connecting)');
    expect(await pc.executeCommand('systemctl is-active strongswan')).toContain('active');
  });

  it('l unite strongswan-starter existe et porte l ExecStart amont', async () => {
    const pc = poste();
    const chat = await pc.executeCommand('cat /usr/lib/systemd/system/strongswan-starter.service');
    expect(chat).toContain('Description=strongSwan IPsec IKEv1/IKEv2 daemon using ipsec.conf');
    expect(chat).toContain('ExecStart=/usr/sbin/ipsec start --nofork');
    expect(chat).toContain('syslog.target');
  });

  it('systemctl status strongswan repond au lieu de nier l unite', async () => {
    const pc = poste();
    const sortie = await pc.executeCommand('systemctl status strongswan');
    expect(sortie).not.toContain('could not be found');
    expect(sortie).toContain('strongswan-starter');
  });

  it('ipsec start rend l unite active pour systemctl', async () => {
    const pc = poste();
    await pc.executeCommand('sudo systemctl stop strongswan');
    await pc.executeCommand('sudo ipsec start');
    expect(await pc.executeCommand('systemctl is-active strongswan')).toContain('active');
    expect(await pc.executeCommand('systemctl status strongswan')).toContain('running');
  });

  it('ipsec status apres ipsec start decrit le demon', async () => {
    const pc = poste();
    await pc.executeCommand('sudo ipsec start');
    expect(await pc.executeCommand('sudo ipsec status'))
      .toContain('Security Associations (0 up, 0 connecting)');
  });

  it('systemctl stop coupe le demon que ipsec status observe', async () => {
    const pc = poste();
    await pc.executeCommand('sudo ipsec start');
    await pc.executeCommand('sudo systemctl stop strongswan');
    expect(await pc.executeCommand('sudo ipsec status')).toContain('IPsec is not running');
  });

  it('ipsec stop rend l unite inactive pour systemctl', async () => {
    const pc = poste();
    await pc.executeCommand('sudo ipsec start');
    await pc.executeCommand('sudo ipsec stop');
    expect(await pc.executeCommand('systemctl is-active strongswan')).toContain('inactive');
  });

  it('systemctl start strongswan suffit a ouvrir les vues de ipsec', async () => {
    const pc = poste();
    await pc.executeCommand('sudo ipsec stop');
    await pc.executeCommand('sudo systemctl start strongswan');
    expect(await pc.executeCommand('sudo ipsec statusall'))
      .toContain('Status of IKE charon daemon');
  });
});
