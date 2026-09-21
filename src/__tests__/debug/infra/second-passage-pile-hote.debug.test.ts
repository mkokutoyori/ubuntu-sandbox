/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * SECOND PASSAGE de `docs/AUDIT-SECURITE-INFRA.md`, derniere tranche de
 * sa §5 : LA PILE HOTE — `iptables`, `sudo`, les permissions `oracle`.
 * Les vingt controles de durcissement du premier audit ont tous ete
 * ACCEPTES ; huit ont depuis ete attaques (§6). Ces trois-la ne l'ont
 * jamais ete.
 *
 * Ce qui se mesure ici n'est pas qu'une commande soit acceptee — elles
 * le sont toutes — mais qu'elle APPLIQUE.
 *
 * Deux pieges du labo, payes comptant lors de la premiere passe et donc
 * ecrits ici : sur un `LinuxPC` la session est `user` (uid 1000), donc
 * tout `iptables` sans `sudo` rend << Permission denied >> et le relevé
 * mesure alors l'absence de pare-feu, pas le pare-feu ; et `su <user>`
 * depuis un compte non-root echoue a l'authentification, donc le
 * changement d'identite passe par `sudo su <user> -c "<cmd>"`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const note = (l: string) => { console.log(l); };

async function sh(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const c of lignes) out = await d.executeCommand(c);
  return out;
}

const perte = async (d: LinuxPC, ip: string): Promise<string> =>
  (await pingOnSimulatedClock(d, `ping -c 2 ${ip}`))
    .split('\n').filter((l) => /packet loss/.test(l)).join('').trim();

async function labDeuxHotes() {
  const client = new LinuxPC('linux-pc', 'CLIENT', -150, 0);
  const serveur = new LinuxServer('linux-server', 'SERVEUR', 150, 0);
  client.powerOn(); serveur.powerOn();
  new Cable('lan').connect(client.getPort('eth0')!, serveur.getPort('eth0')!);
  await sh(client, ['ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up']);
  await sh(serveur, ['ip addr add 10.0.0.20/24 dev eth0', 'ip link set eth0 up']);
  return { client, serveur };
}

describe('pile hote — les controles jamais attaques appliquent-ils ?', () => {
  it('iptables : la politique INPUT DROP arrete-t-elle vraiment le trafic ?', async () => {
    const { client, serveur } = await labDeuxHotes();
    note(`[ipt-T] TEMOIN avant tout filtrage : ${await perte(client, '10.0.0.20')}`);
    note(`[ipt-0] iptables SANS sudo sur un poste (uid ${
      (await client.executeCommand('id -u')).trim()}) : ${
      JSON.stringify((await client.executeCommand('iptables -P INPUT DROP')).trim())}`);

    const pose = await sh(serveur, ['iptables -P INPUT DROP']);
    note(`[ipt-1] sur le SERVEUR (uid 0) : ${pose.trim() === '' ? 'accepte (silence)' : JSON.stringify(pose.trim())}`);
    note(`[ipt-2] rendu par iptables -L : ${
      (await serveur.executeCommand('iptables -L')).split('\n')
        .filter((l) => /^Chain INPUT/.test(l)).join('').trim()}`);
    note(`[ipt-3] ping APRES la politique DROP : ${await perte(client, '10.0.0.20')}`);

    await sh(serveur, ['iptables -A INPUT -p icmp -j ACCEPT']);
    note(`[ipt-4] TEMOIN — la meme politique avec -p icmp -j ACCEPT : ${
      await perte(client, '10.0.0.20')}`);
    expect(true).toBe(true);
  }, 180000);

  it('iptables : un port autorise passe-t-il pendant qu un autre est ferme ?', async () => {
    const { client, serveur } = await labDeuxHotes();
    await sh(serveur, ['systemctl start ssh', 'systemctl start nginx']);
    note(`[port-T1] TEMOIN avant filtrage, 22 : ${await client.executeCommand('nc -zv 10.0.0.20 22')}`);
    note(`[port-T2] TEMOIN avant filtrage, 80 : ${await client.executeCommand('nc -zv 10.0.0.20 80')}`);

    await sh(serveur, [
      'iptables -A INPUT -p tcp --dport 22 -j ACCEPT',
      'iptables -P INPUT DROP',
    ]);
    note(`[port-1] APRES (22 autorise, politique DROP), 22 : ${
      await client.executeCommand('nc -zv 10.0.0.20 22')}`);
    note(`[port-2] APRES, 80 (aucune regle) : ${
      await client.executeCommand('nc -zv 10.0.0.20 80')}`);
    expect(true).toBe(true);
  }, 180000);

  it('iptables : la regle ESTABLISHED,RELATED laisse-t-elle revenir les reponses ?', async () => {
    const { client, serveur } = await labDeuxHotes();
    await sh(client, ['sudo iptables -P INPUT DROP']);
    note(`[ct-1] CLIENT durci : ${(await client.executeCommand('sudo iptables -L INPUT -n'))
      .split('\n')[0].trim()}`);
    note(`[ct-2] TEMOIN — le SERVEUR ping le CLIENT durci : ${
      await perte(serveur as unknown as LinuxPC, '10.0.0.10')}`);
    note(`[ct-3] ping SORTANT du client, SANS regle d etat : ${await perte(client, '10.0.0.20')}`);

    await sh(client, ['sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT']);
    note(`[ct-4] le MEME ping sortant AVEC la regle ESTABLISHED,RELATED : ${
      await perte(client, '10.0.0.20')}`);
    note(`[ct-5] TEMOIN — le SERVEUR ping toujours le CLIENT (doit rester ferme) : ${
      await perte(serveur as unknown as LinuxPC, '10.0.0.10')}`);
    note(`[ct-6] compteurs : ${(await client.executeCommand('sudo iptables -L INPUT -v -n'))
      .split('\n')[0].trim()}`);
    expect(true).toBe(true);
  }, 180000);

  it('sudo : une commande hors de la liste est-elle refusee, et la session revient-elle ?', async () => {
    const pc = new LinuxPC('linux-pc', 'POSTE', 0, 0);
    pc.powerOn();
    await sh(pc, [
      'sudo useradd -m operateur',
      'sudo useradd -m sanssudo',
      `sudo sh -c 'echo "operateur ALL=(ALL) NOPASSWD: /bin/ls" >> /etc/sudoers'`,
    ]);
    note(`[sudo-0] ligne posee : ${(await pc.executeCommand('sudo grep operateur /etc/sudoers')).trim()}`);
    note(`[sudo-1] sudo -l vu par operateur : ${
      (await pc.executeCommand('sudo su operateur -c "sudo -l"')).split('\n').pop()?.trim()}`);

    for (const forme of ['/bin/ls /root', '/usr/bin/ls /root', 'ls /root']) {
      note(`[sudo-2] sudo -n ${forme} : ${
        JSON.stringify((await pc.executeCommand(`sudo su operateur -c "sudo -n ${forme}"`)).slice(0, 90))}`);
    }
    note(`[sudo-3] commande HORS LISTE (sudo -n cat /etc/shadow) : ${
      JSON.stringify((await pc.executeCommand('sudo su operateur -c "sudo -n cat /etc/shadow"')).slice(0, 110))}`);
    note(`[sudo-4] TEMOIN — un compte absent de sudoers : ${
      JSON.stringify((await pc.executeCommand('sudo su sanssudo -c "sudo -n ls /root"')).slice(0, 110))}`);

    note(`[sudo-5] uid de la session AVANT : ${(await pc.executeCommand('id -u')).trim()}`);
    note(`[sudo-6] sudo su operateur -c "id -u" : ${
      (await pc.executeCommand('sudo su operateur -c "id -u"')).trim()}`);
    note(`[sudo-7] uid de la session APRES le su a usage unique : ${
      (await pc.executeCommand('id -u')).trim()}`);
    note(`[sudo-8] journal : ${(await pc.executeCommand('sudo cat /var/log/auth.log'))
      .split('\n').filter((l) => /sudo/.test(l)).slice(-1).join('').trim() || '(rien)'}`);
    expect(true).toBe(true);
  }, 180000);

  it('permissions : un compte quelconque peut-il lire les fichiers d Oracle ?', async () => {
    const srv = new LinuxServer('linux-server', 'DB', 0, 0);
    srv.powerOn();
    await sh(srv, [
      'groupadd oinstall', 'groupadd dba',
      'useradd -m -g oinstall -G dba oracle',
      'useradd -m intrus',
      'mkdir -p /u01/app/oracle/oradata/ORCL',
      'echo DONNEES > /u01/app/oracle/oradata/ORCL/system01.dbf',
      'chown -R oracle:oinstall /u01/app/oracle',
      'chmod 640 /u01/app/oracle/oradata/ORCL/system01.dbf',
      'chmod 750 /u01/app/oracle/oradata/ORCL',
    ]);
    note(`[ora-0] pose : ${(await srv.executeCommand('ls -l /u01/app/oracle/oradata/ORCL'))
      .split('\n').pop()?.trim()}`);
    note(`[ora-1] groupes d oracle : ${(await srv.executeCommand('su oracle -c "id"')).trim()}`);
    note(`[ora-2] TEMOIN — oracle lit son propre fichier : ${
      JSON.stringify((await srv.executeCommand(
        'su oracle -c "cat /u01/app/oracle/oradata/ORCL/system01.dbf"')).trim())}`);
    note(`[ora-3] l intrus lit le fichier de donnees : ${
      JSON.stringify((await srv.executeCommand(
        'su intrus -c "cat /u01/app/oracle/oradata/ORCL/system01.dbf"')).trim())}`);
    note(`[ora-4] l intrus liste le repertoire (750) : ${
      JSON.stringify((await srv.executeCommand(
        'su intrus -c "ls /u01/app/oracle/oradata/ORCL"')).trim())}`);
    note(`[ora-5] /root, mode ${(await srv.executeCommand('ls -ld /root')).trim().split(/\s+/)[0]} : ${
      JSON.stringify((await srv.executeCommand('su intrus -c "ls /root"')).trim())}`);
    note(`[ora-6] TEMOIN — un repertoire lisible de tous : ${
      JSON.stringify((await srv.executeCommand('su intrus -c "ls /etc/ssh"')).trim())}`);
    expect(true).toBe(true);
  }, 180000);
});
