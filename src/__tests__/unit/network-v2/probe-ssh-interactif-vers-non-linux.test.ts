/**
 * Sonde — `ssh <equipement>` sans commande n'ouvrait aucune session.
 *
 * Mesure AVANT, depuis un `LinuxPC`, avec l'entree standard
 * `…\nshow version\nexit\n` :
 *
 *   ssh admin@<routeur>      -> "Cisco IOS Software\nR1#\n
 *                                Connection to 10.0.0.2 closed."
 *   ssh admin@<commutateur>  -> "Connection to 10.0.1.2 closed."
 *   ssh admin@<ASA>          -> "ssh: connect to host … Connection refused"
 *
 * Dans les deux premiers cas la banniere et le motd sont recopies puis la
 * session se ferme : `show version` n'est jamais execute, l'entree est
 * ignoree en entier. `runCrossPlatformExec` le fait explicitement -- sans
 * commande distante, il assemble `banner + motd + "Connection to X
 * closed."` et rend la main sans ouvrir le moindre canal. Dans le
 * troisieme, rien ne s'ouvre du tout : un pare-feu n'est pas un
 * `SshExecTarget`, donc la garde « seule une LinuxMachine embarque un
 * sshd » refuse avant meme d'essayer.
 *
 * La cause commune est en amont : `wireExecTarget` exige au moins DEUX
 * positionnels, donc `ssh hote` sans commande ne demande jamais de
 * session filaire. Le meme boitier repond pourtant en `telnet`, avec une
 * vraie session, depuis les lots precedents : un equipement, deux
 * protocoles, deux capacites.
 *
 * CINQ cas sur dix tombent avant la correction (discrimines sur
 * `0d539d97'). Les CINQ autres sont NOMMES :
 *
 * (Les deux cas d'equipement Cisco n'attendent PAS `Cisco IOS Software` :
 * la banniere recopiee le contient deja, si bien qu'une telle attente
 * passerait sans qu'aucune commande ne s'execute -- mesure faite, le cas
 * routeur passait ainsi a vide. Ils attendent donc `System image file
 * is` et `ROM: Bootstrap program`, que seule la VRAIE sortie de
 * `show version` porte.)
 *
 *   - telnet vers le meme commutateur execute bien `show version` :
 *     TEMOIN. Il prouve que le laboratoire, le compte et la CLI sont
 *     bons, donc qu'un SSH muet est un chemin manquant et non un
 *     laboratoire casse.
 *   - `ssh hote "commande"` a un coup rend toujours sa sortie :
 *     NON-REGRESSION du lot precedent.
 *   - `ssh` vers un hote LINUX annonce toujours son ouverture de
 *     session : NON-REGRESSION. Ce chemin-la n'est PAS touche ici -- il
 *     a son propre terminal interactif, et l'entree standard y est
 *     ignoree de la meme facon, ce qui est un autre sujet.
 *   - « la session se termine par `Connection to <hote> closed.' » passe
 *     AVANT comme APRES : NON-REGRESSION, et elle a failli etre perdue.
 *     AVANT, la ligne venait de `runCrossPlatformExec', qui l'ecrivait
 *     sans avoir rien ouvert ; APRES, elle vient du client, apres une
 *     vraie session. C'est le mot d'OpenSSH lui-meme
 *     (`clientloop.c:1669', `quit_message("Connection to %s closed.",
 *     host)', emis quand la session avait un pseudo-terminal).
 *
 *   - « le mot de passe n'est jamais rejoue comme une commande » passe
 *     AVANT comme APRES, mais pour des raisons opposees, et c'est
 *     pourquoi il est ecrit. AVANT il passe A VIDE : aucune ligne n'etait
 *     executee, donc aucune ne pouvait etre rejouee. APRES il passe parce
 *     que la premiere ligne est explicitement sautee. Entre les deux, il
 *     a attrape un defaut que j'avais INTRODUIT en cours de route -- la
 *     premiere ligne sert a l'authentification SSH, hors bande, et la
 *     rejouer dans le canal en faisait une commande : le routeur
 *     repondait `R1#cisco' puis « Unknown command or computer name »,
 *     et sur un vrai boitier le secret serait entre dans l'historique et
 *     dans les journaux.
 *
 * La session filaire n'est demandee que lorsqu'il y a une commande
 * distante OU que le pair n'est pas Linux. Sans cette garde, un simple
 * `ssh alice@<hote Linux>' ouvrait desormais une vraie poignee de main
 * pour la jeter aussitot -- le chemin interactif Linux ne s'en sert pas
 * -- et six cas VERTS de `linux-lan-ssh-suite' et
 * `cross-equipment-ssh-suite' tombaient : leurs `setup' lancent le `ssh'
 * sans l'attendre (`void l.pc1.executeCommand(...)'), si bien que le
 * `known_hosts' et l'`auth.log' n'etaient plus ecrits avant le `cat' qui
 * les lit. Mesure : 6 rouges avec la poignee de main inutile, 0 sans.
 *
 * Limite FERMEE DEPUIS, et la note est mise a jour plutot que laissee a
 * induire en erreur : `ISshServerContext.getMotd()' etait declare et lu
 * par personne, l'accuse de `shell_open' ne publiant que le prompt. Il
 * publie desormais aussi le motd, et `relayScriptedShell' le rend.
 *
 * L'AVERTISSEMENT QUE PORTAIT CETTE NOTE ETAIT JUSTE, et il s'est
 * realise : « les deux s'ajouteraient ». En preposant le motd pour TOUS
 * les appelants, un lot l'a fait paraitre deux fois sur le chemin Linux,
 * ou `LinuxSshClient' compose deja sa banniere. Le prefixe est depuis
 * BORNE au chemin qui n'en compose aucune — celui des pairs non-Linux,
 * ou le fil est le seul porteur du texte d'ouverture. `SshInteractive
 * SubShell', qui compose la sienne par `composeSshLoginBanner', ne lit
 * pas `initialMotd()' : il n'y a pas de second cumul de ce cote.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function routerLab(): Promise<LinuxPC> {
  const r = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P1');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  new Cable('c1').connect(pc.getPort('eth0')!, r.getPorts()[0]);
  for (const l of [
    'enable', 'configure terminal', 'hostname R1', 'ip domain-name lab',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret cisco',
    'line vty 0 4', 'login local', 'transport input all', 'exit',
    'crypto key generate rsa modulus 2048', 'end',
  ]) await r.executeCommand(l);
  await settle();
  return pc;
}

async function switchLab(): Promise<LinuxPC> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'P2');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.1.10'), MASK);
  new Cable('c2').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  for (const l of [
    'enable', 'configure terminal', 'hostname SW1', 'ip domain-name lab',
    'interface Vlan1', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret cisco',
    'line vty 0 4', 'login local', 'transport input all', 'exit',
    'crypto key generate rsa modulus 2048', 'end',
  ]) await sw.executeCommand(l);
  await settle();
  return pc;
}

async function asaLab(): Promise<LinuxPC> {
  const fw = new AsaFirewall('firewall-cisco', 'FW1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P3');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.2.10'), MASK);
  new Cable('c3').connect(pc.getPort('eth0')!, fw.getPorts()[0]);
  for (const l of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside', 'security-level 100',
    'ip address 10.0.2.2 255.255.255.0', 'no shutdown', 'exit',
    'username admin password Secret123 privilege 15',
    'aaa authentication ssh console LOCAL',
    'ssh 10.0.2.0 255.255.255.0 inside', 'end',
  ]) await fw.executeCommand(l);
  await settle();
  return pc;
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('`ssh <equipement>` sans commande ouvre une vraie session', () => {
  it('temoin : telnet vers le meme commutateur execute bien la commande', async () => {
    const pc = await switchLab();
    expect(await pc.executeCommand('telnet 10.0.1.2', 'admin\ncisco\nshow version\nexit\n'))
      .toContain('Cisco IOS Software');
  }, 30000);

  it('non-regression : `ssh hote "commande"` rend toujours sa sortie', async () => {
    const pc = await routerLab();
    expect(await pc.executeCommand('ssh admin@10.0.0.2 "show version"', 'cisco\n'))
      .toContain('Cisco IOS Software');
  }, 30000);

  it('non-regression : ssh vers un hote Linux annonce son ouverture', async () => {
    const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
    const pc = new LinuxPC('linux-pc', 'P4');
    pc.getPort('eth0')!.configureIP(new IPAddress('10.0.3.10'), MASK);
    srv.getPort('eth0')!.configureIP(new IPAddress('10.0.3.2'), MASK);
    new Cable('c4').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
    const um = (srv as unknown as { executor: { userMgr: {
      useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
    } } }).executor.userMgr;
    um.useradd('bob', { m: true, s: '/bin/bash' });
    um.setPassword('bob', 'pw');
    expect(await pc.executeCommand('ssh bob@10.0.3.2', 'pw\nwhoami\nexit\n'))
      .toContain('Welcome to Ubuntu');
  }, 30000);

  it('non-regression : la session se termine par `Connection to <hote> closed.`', async () => {
    const pc = await routerLab();
    expect(await pc.executeCommand('ssh admin@10.0.0.2', 'cisco\nshow version\nexit\n'))
      .toContain('Connection to 10.0.0.2 closed.');
  }, 30000);

  it('routeur : la commande saisie est reellement executee', async () => {
    const pc = await routerLab();
    expect(await pc.executeCommand('ssh admin@10.0.0.2', 'cisco\nshow version\nexit\n'))
      .toContain('System image file is');
  }, 30000);

  it('commutateur : la commande saisie est reellement executee', async () => {
    const pc = await switchLab();
    expect(await pc.executeCommand('ssh admin@10.0.1.2', 'cisco\nshow version\nexit\n'))
      .toContain('ROM: Bootstrap program');
  }, 30000);

  it('pare-feu : la session s\'ouvre au lieu d\'etre refusee', async () => {
    const pc = await asaLab();
    const out = await pc.executeCommand('ssh admin@10.0.2.2', 'Secret123\nenable\n\nshow version\nexit\n');
    expect(out).not.toContain('Connection refused');
  }, 30000);

  it('le mot de passe saisi n\'est jamais rejoue comme une commande', async () => {
    const pc = await routerLab();
    const out = await pc.executeCommand('ssh admin@10.0.0.2', 'cisco\nshow version\nexit\n');
    expect(out).not.toContain('R1#cisco');
    expect(out).not.toContain('Unknown command');
  }, 30000);

  it('pare-feu : `enable` puis `show version` rendent la sortie de l\'ASA', async () => {
    const pc = await asaLab();
    const out = await pc.executeCommand('ssh admin@10.0.2.2', 'Secret123\nenable\n\nshow version\nexit\n');
    expect(out).toContain('Cisco Adaptive Security Appliance');
  }, 30000);

  it('l\'invite suit le mode : `FW1#disable` puis `FW1>enable`', async () => {
    const pc = await asaLab();
    const out = await pc.executeCommand(
      'ssh admin@10.0.2.2', 'Secret123\ndisable\nenable\n\nshow version\nexit\n');
    expect(out).toContain('FW1#disable');
    expect(out).toContain('FW1>enable');
    expect(out).toContain('FW1#show version');
  }, 30000);
});
