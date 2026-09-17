/**
 * Sonde — `ufw deny` sur un port deja autorise laissait le port OUVERT.
 *
 * Mesure AVANT (sur `eb7ba709'), sur un serveur Linux cable a un client :
 *
 *   ufw enable          -> Firewall is active and enabled on system startup
 *   ufw allow 22/tcp    -> Rule added
 *   ufw deny  22/tcp    -> Rule added            <- un VRAI ufw dit
 *                                                  « Rule updated »
 *   ufw status          -> 22/tcp ALLOW IN Anywhere
 *                          22/tcp DENY  IN Anywhere
 *   ssh alice@10.0.0.2  -> alice
 *
 * L'operateur ferme un port, la CLI le lui confirme, la table montre sa
 * regle -- et la session passe toujours. Les deux regles coexistent,
 * l'ALLOW est la premiere, elle gagne. C'est la forme que la regle 6
 * nomme, dans son sens le plus dangereux : un critere de securite range,
 * rendu, et sans effet -- qui echoue OUVERT.
 *
 * AUTORITE : la source de ufw 0.36, `src/backend_iptables.py`, methode
 * `set_rule`. Elle compare la regle entrante a chaque regle existante et
 * distingue TROIS cas, aux lignes 1042-1131 :
 *
 *   ret == 0               -> la meme, exactement : « Skipping adding
 *                             existing rule »
 *   ret <  0 (action seule
 *   differente)            -> `found = True; modified = True;
 *                             newrules.append(rule.dup_rule())` puis
 *                             « Rule updated » et rechargement de la
 *                             chaine
 *   aucune correspondance  -> « Rule added »
 *
 * Le remplacement se fait A LA PLACE de l'ancienne regle
 * (`newrules.append` dans la boucle), donc l'ORDRE est conserve : c'est
 * ce qui fait qu'un `deny` posterieur ferme reellement le port au lieu
 * de se ranger derriere l'`allow`.
 *
 * Deux autres ecarts, mesures au meme endroit et fermes ici.
 *
 * `ufw allow from 999.999.999.999` etait ACCEPTE et rendu dans la table.
 * Un vrai ufw valide par `ufw.util.valid_address()`, qui passe par
 * `socket.inet_pton()` (`src/util.py:118`), et `Rule.set_src()` leve
 * « Bad source address » (`src/common.py:280`), `set_dst()` « Bad
 * destination address » (l.290). L'analyse passe desormais par
 * `IPAddress`/`IPv6Address` -- la classe, pas un `^\d+\.\d+\.\d+\.\d+`
 * qui accepte justement 999.999.999.999.
 *
 * `/etc/default/ufw` N'EXISTAIT PAS, alors que c'est le fichier qui
 * PORTE les politiques par defaut qu'affiche `ufw status verbose`. La
 * vue et son magasin ne pouvaient pas se contredire pour une seule
 * raison : le magasin etait absent. Il est ecrit a partir des politiques
 * vivantes, au format du vrai fichier (`conf/ufw.defaults' de la meme
 * source), et il suit `ufw default deny outgoing` comme la vue.
 *
 * NEUF cas sur treize tombent avant la correction (discrimines sur
 * `eb7ba709'). Les QUATRE autres sont NOMMES :
 *
 *   - port autorise, la session passe : TEMOIN. Il prouve que le
 *     laboratoire, le compte et le serveur sont bons, donc qu'un port
 *     « ferme » qui laisse passer est une regle sans effet et non un
 *     laboratoire casse.
 *   - re-ajouter la MEME regle reste sans effet, et supprimer une regle
 *     absente le dit : NON-REGRESSIONS. Ces deux branches-la de
 *     `set_rule` etaient DEJA justes ; seule celle du remplacement
 *     manquait, et les garder ecrites empeche de la reparer en cassant
 *     ses voisines.
 *   - le service et le processus restent coherents : NON-REGRESSION.
 *     `ufw enable` demarre `ufw.service` et `/lib/ufw/ufw-init` apparait
 *     dans `ps` -- les autres piles que celle des regles ne bougent pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SRV_IP = '10.0.0.2';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const mask = new SubnetMask('255.255.255.0');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), mask);
  srv.getPort('eth0')!.configureIP(new IPAddress(SRV_IP), mask);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await srv.executeCommand('sudo ufw enable');
  return { pc, srv };
}

const ssh = (pc: LinuxPC): Promise<string> => pc.executeCommand(
  `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SRV_IP} whoami`,
).then(String);

describe('ufw remplace une regle au lieu d\'en empiler une seconde', () => {
  it('temoin : port autorise, la session passe', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('sudo ufw allow 22/tcp');
    expect((await ssh(pc)).trim()).toBe('alice');
  }, 30000);

  it('`deny` apres `allow` dit `Rule updated`', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo ufw allow 22/tcp');
    expect(String(await srv.executeCommand('sudo ufw deny 22/tcp')))
      .toContain('Rule updated');
  }, 30000);

  it('`deny` apres `allow` FERME vraiment le port', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('sudo ufw allow 22/tcp');
    await srv.executeCommand('sudo ufw deny 22/tcp');
    expect((await ssh(pc)).trim()).not.toBe('alice');
  }, 30000);

  it('`allow` apres `deny` ROUVRE le port', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('sudo ufw deny 22/tcp');
    await srv.executeCommand('sudo ufw allow 22/tcp');
    expect((await ssh(pc)).trim()).toBe('alice');
  }, 30000);

  it('la table n\'en garde qu\'UNE, avec la derniere action', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo ufw allow 22/tcp');
    await srv.executeCommand('sudo ufw deny 22/tcp');
    const lignes = String(await srv.executeCommand('sudo ufw status'))
      .split('\n').filter((l) => l.startsWith('22/tcp') && !l.includes('(v6)'));
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain('DENY');
  }, 30000);

  it('iptables, l\'autre vue, montre la MEME action', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo ufw allow 22/tcp');
    await srv.executeCommand('sudo ufw deny 22/tcp');
    const save = String(await srv.executeCommand('sudo iptables -S'));
    expect(save).toContain('-A ufw-user-input -p tcp --dport 22 -j DROP');
    expect(save).not.toContain('-A ufw-user-input -p tcp --dport 22 -j ACCEPT');
  }, 30000);

  it('non-regression : re-ajouter la MEME regle reste sans effet', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo ufw allow 22/tcp');
    expect(String(await srv.executeCommand('sudo ufw allow 22/tcp')))
      .toContain('Skipping adding existing rule');
  }, 30000);

  it('non-regression : supprimer une regle absente le dit', async () => {
    const { srv } = await lab();
    expect(String(await srv.executeCommand('sudo ufw delete allow 9999/tcp')))
      .toContain('Could not delete non-existent rule');
  }, 30000);

  it('une adresse impossible est refusee, dans les mots de ufw', async () => {
    const { srv } = await lab();
    expect(String(await srv.executeCommand('sudo ufw allow from 999.999.999.999')))
      .toContain('ERROR: Bad source address');
  }, 30000);

  it('et elle n\'entre pas dans la table', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo ufw allow from 999.999.999.999');
    expect(String(await srv.executeCommand('sudo ufw status')))
      .not.toContain('999.999.999.999');
  }, 30000);

  it('`/etc/default/ufw` existe et porte les politiques par defaut', async () => {
    const { srv } = await lab();
    const f = String(await srv.executeCommand('sudo cat /etc/default/ufw'));
    expect(f).toContain('DEFAULT_INPUT_POLICY="DROP"');
    expect(f).toContain('DEFAULT_OUTPUT_POLICY="ACCEPT"');
  }, 30000);

  it('le fichier SUIT la politique qu\'on change', async () => {
    const { srv } = await lab();
    await srv.executeCommand('sudo ufw default deny outgoing');
    const f = String(await srv.executeCommand('sudo cat /etc/default/ufw'));
    expect(f).toContain('DEFAULT_OUTPUT_POLICY="DROP"');
    expect(String(await srv.executeCommand('sudo ufw status verbose')))
      .toContain('deny (outgoing)');
  }, 30000);

  it('non-regression : le service et le processus restent coherents', async () => {
    const { srv } = await lab();
    expect(String(await srv.executeCommand('sudo systemctl is-enabled ufw')).trim())
      .toBe('enabled');
    expect(String(await srv.executeCommand('ps aux'))).toContain('/lib/ufw/ufw-init');
  }, 30000);
});
