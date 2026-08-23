/**
 * strongSwan — la commande `ipsec` LIT enfin `/etc/ipsec.conf`.
 *
 * Tout etait constant : `ipsec up X` annoncait « initiating IKE_SA X[1]
 * to 0.0.0.0 » quelle que soit la configuration — y compris pour une
 * connexion qui n'existe pas —, `statusall` rendait quatre lignes fixes,
 * et le fichier n'etait lu par personne. Une machine annoncait donc une
 * negociation vers une adresse litterale.
 *
 * Ce qui est ferme ici : la configuration est REELLE (sections, heritage
 * de `conn %default`, `ipsec.secrets`), les vues la rendent, et
 * `ipsec up` REFUSE en nommant ce qui manque au lieu de mentir. Ce qui
 * reste ouvert est ecrit au TODO : il n'y a pas de demon IKE sur un
 * poste Linux, donc aucune SA ne peut s'etablir depuis la.
 *
 * Les formats sont attestes contre le code de strongSwan
 * (`stroke_control.c`, `stroke_list.c`) : `no config named '%s'`,
 * l'alignement `%12s:` des blocs `Connections:`, et
 * `Security Associations (%u up, %u connecting):`.
 *
 * Discrimine en retirant l'enregistrement de la commande et l'ancien
 * `case 'ipsec'` : 7 des 13 cas tombent. Les 6 qui passent des deux
 * cotes sont nommes ici — les 4 cas du seul lecteur `IpsecConf.ts`,
 * fichier NEUF que ce `stash` ne retire pas ; le TEMOIN sans fichier,
 * dont c'est l'objet ; et « le demon arrete refuse les vues », qui etait
 * deja juste avant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { parseIpsecConf, parseIpsecSecrets, secretFor } from '@/network/devices/linux/ipsec/IpsecConf';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const CONF = [
  'config setup',
  '    charondebug="ike 1"',
  '',
  'conn %default',
  '    keyexchange=ikev2',
  '    authby=secret',
  '',
  'conn maison',
  '    left=10.0.0.1',
  '    leftsubnet=192.168.1.0/24',
  '    right=203.0.113.9',
  '    rightsubnet=192.168.2.0/24',
  '    auto=add',
  '',
  'conn portable',
  '    left=10.0.0.1',
  '    right=%any',
  '    keyexchange=ikev1',
].join('\n');

async function poste(options: { conf?: string; secrets?: string } = {}): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'poste', 0, 0);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  if (options.conf !== undefined) {
    await pc.executeCommand(`printf '${options.conf}\n' | sudo tee /etc/ipsec.conf`);
  }
  if (options.secrets !== undefined) {
    await pc.executeCommand(`printf '${options.secrets}\n' | sudo tee /etc/ipsec.secrets`);
  }
  await pc.executeCommand('sudo ipsec start');
  return pc;
}

describe('le lecteur de configuration', () => {
  it('les sections et l heritage de `conn %default` sont reels', () => {
    const fichier = parseIpsecConf(CONF);
    expect(fichier.conns.map(c => c.name)).toEqual(['maison', 'portable']);
    expect(fichier.conns[0].settings.get('keyexchange')).toBe('ikev2');
    expect(fichier.conns[1].settings.get('keyexchange')).toBe('ikev1');
    expect(fichier.conns[0].settings.get('authby')).toBe('secret');
  });

  it('`config setup` n est pas une connexion', () => {
    const fichier = parseIpsecConf(CONF);
    expect(fichier.setup.get('charondebug')).toBe('"ike 1"');
    expect(fichier.conns.some(c => c.name === 'setup')).toBe(false);
  });

  it('un commentaire n est pas un reglage', () => {
    const fichier = parseIpsecConf('conn a\n    # right=1.2.3.4\n    left=10.0.0.1\n');
    expect(fichier.conns[0].settings.has('right')).toBe(false);
    expect(fichier.conns[0].settings.get('left')).toBe('10.0.0.1');
  });

  it('le secret se cherche par les DEUX bouts, et `%any` couvre tout', () => {
    const secrets = parseIpsecSecrets('10.0.0.1 203.0.113.9 : PSK "abc"\n%any : PSK "defaut"\n');
    expect(secretFor(secrets, '10.0.0.1', '203.0.113.9')).toBe('abc');
    expect(secretFor(secrets, '10.0.0.1', '198.51.100.1')).toBe('defaut');
  });
});

describe('les vues rendent ce que le fichier dit', () => {
  it('`statusall` liste les connexions du fichier', async () => {
    const pc = await poste({ conf: CONF });
    const sortie = await pc.executeCommand('sudo ipsec statusall');

    expect(sortie).toContain('Connections:');
    expect(sortie).toContain('10.0.0.1...203.0.113.9');
    expect(sortie).toContain('IKEv2');
    expect(sortie).toContain('IKEv1');
    expect(sortie).toContain('192.168.1.0/24 === 192.168.2.0/24 TUNNEL');
    expect(sortie).toContain('uses pre-shared key authentication');
  });

  it('elle annonce les adresses REELLES de la machine', async () => {
    const pc = await poste({ conf: CONF });
    const sortie = await pc.executeCommand('sudo ipsec statusall');
    expect(sortie).toContain('Listening IP addresses:');
    expect(sortie).toContain('10.0.0.1');
  });

  it('TEMOIN — sans fichier, aucune connexion n est listee', async () => {
    const pc = await poste();
    const sortie = await pc.executeCommand('sudo ipsec statusall');
    expect(sortie).not.toContain('Connections:');
    expect(sortie).toContain('Security Associations (0 up, 0 connecting):');
  });

  it('le nom des colonnes suit l alignement de strongSwan', async () => {
    const pc = await poste({ conf: CONF });
    const sortie = await pc.executeCommand('sudo ipsec statusall');
    expect(sortie).toContain('      maison:  10.0.0.1...203.0.113.9  IKEv2');
  });
});

describe('`ipsec up` ne ment plus', () => {
  it('une connexion inconnue est refusee dans les mots de strongSwan', async () => {
    const pc = await poste({ conf: CONF });
    const sortie = await pc.executeCommand('sudo ipsec up inexistante');
    expect(sortie).toContain("no config named 'inexistante'");
    expect(sortie).not.toContain('0.0.0.0');
  });

  it('une connexion connue nomme le VRAI pair, et dit ce qui manque', async () => {
    const pc = await poste({ conf: CONF, secrets: '10.0.0.1 203.0.113.9 : PSK "abc"' });
    const sortie = await pc.executeCommand('sudo ipsec up maison');
    expect(sortie).toContain('initiating IKE_SA maison[1] to 203.0.113.9');
    expect(sortie).toContain('no IKE daemon');
  });

  it('sans secret partage, c est le SECRET qui est nomme', async () => {
    const pc = await poste({ conf: CONF });
    const sortie = await pc.executeCommand('sudo ipsec up maison');
    expect(sortie).toContain('no shared key found');
  });

  it('le demon arrete refuse les vues, comme le vrai', async () => {
    const pc = await poste({ conf: CONF });
    await pc.executeCommand('sudo ipsec stop');
    expect(await pc.executeCommand('sudo ipsec status')).toContain('IPsec is not running');
  });

  it('supprimer le binaire fait echouer la commande', async () => {
    const pc = await poste({ conf: CONF });
    await pc.executeCommand('sudo rm /usr/sbin/ipsec');
    expect(await pc.executeCommand('sudo ipsec status'))
      .toContain('No such file or directory');
  });
});
