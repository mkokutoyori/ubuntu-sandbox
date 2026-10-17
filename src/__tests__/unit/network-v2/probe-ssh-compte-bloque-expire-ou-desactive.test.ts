/*
 * Un compte bloque, expire ou desactive peut-il ouvrir une session SSH ? La
 * reponse depend de la methode, sur Linux comme sur Windows.
 *
 * LINUX (OpenSSH 8.9p1, auth.c allowed_user, Ubuntu 22.04 avec UsePAM yes) :
 * le verrou `passwd -l` (hash prefixe de « ! ») ne ferme que le mot de passe ;
 * la cle entre parce que pam_unix, en phase compte, ne regarde que
 * l'expiration. Sans PAM (UsePAM no), allowed_user refuse le compte verrouille
 * (« User %.100s not allowed because account is locked ») quelle que soit la
 * methode. `chage -E 0` ferme tout par pam_unix, un shell nologin laisse
 * entrer et dit « This account is currently not available. », DenyUsers
 * refuse avant toute authentification.
 *
 * WINDOWS (Win32-OpenSSH, win32_usertoken_utils.c) : le mot de passe passe
 * par LogonUserExExW (LOGON32_LOGON_NETWORK_CLEARTEXT), la cle par un logon
 * S4U (LsaLogonUser, KerbS4ULogon / MsV1_0S4ULogon). Un S4U ne presente aucun
 * mot de passe : un mot de passe EXPIRE n'empeche pas la cle, mais un compte
 * desactive, expire ou verrouille par le seuil de blocage est refuse par la
 * LSA pour les deux methodes.
 *
 * MESURE DE DEPART : 8 cas sur 20 tombent. Le serveur Windows laissait entrer
 * par la cle un compte desactive ou verrouille ; `net user /expires:` tombait
 * dans les arguments positionnels, renvoyait « completed successfully » et
 * ne stockait rien (« Account expires Never » restait affiche), donc aucune
 * expiration de compte n'existait pour decider ; Set-LocalUser ignorait
 * -AccountExpires. Cote Linux, le refus « account is locked » de
 * allowed_user (UsePAM no) etait decide mais jamais ecrit dans auth.log.
 *
 * Passent des deux cotes : les TEMOINS (compte ordinaire entre par cle et
 * mot de passe, sur les deux systemes) qui prouvent que le laboratoire monte ;
 * et la non-regression du comportement Linux sous PAM (passwd -l, chage -E,
 * nologin, DenyUsers), deja correct. Le cas « mot de passe expire » Windows
 * passe aussi des deux cotes : maxpwage refusait deja le mot de passe, et la
 * cle n'a jamais ete bloquee par lui.
 * Les directives sshd_config doivent preceder la premiere occurrence
 * (sshd prend la premiere) : UsePAM est donc remplace, DenyUsers prepose.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function wire(devices: Array<{ getPorts(): Array<{ configureIP(ip: IPAddress, mask: SubnetMask): void }> }>, prefix: string): void {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  devices.forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(`${prefix}.${10 + index * 10}`), mask);
  });
}

describe('serveur Linux', () => {
  const KEY = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id carol@10.95.0.20 whoami';
  const PASSWORD = 'sshpass -p wonderland ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no carol@10.95.0.20 whoami';

  async function lab() {
    const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const server = new LinuxServer('linux-server', 'SRV');
    wire([client, server], '10.95.0');
    client.powerOn();
    server.powerOn();
    await server.executeCommand('useradd -m -s /bin/bash carol');
    await server.executeCommand('sh -c \'echo carol:wonderland | chpasswd\'');
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/id");
    await server.executeCommand('mkdir -p /home/carol/.ssh');
    await server.executeCommand(`sh -c 'echo "${(await client.executeCommand('cut -d" " -f1,2 ~/id.pub')).trim()}" > /home/carol/.ssh/authorized_keys'`);
    await server.executeCommand('chown -R carol:carol /home/carol/.ssh');
    await server.executeCommand('chmod 700 /home/carol/.ssh');
    await server.executeCommand('chmod 600 /home/carol/.ssh/authorized_keys');
    await server.executeCommand('systemctl start ssh');
    return { client, server };
  }

  it('TEMOIN: un compte ordinaire entre par la cle et par le mot de passe', async () => {
    const { client } = await lab();
    expect((await client.executeCommand(KEY)).trim()).toBe('carol');
    expect((await client.executeCommand(PASSWORD)).trim()).toBe('carol');
  }, 120_000);

  it('passwd -l : le mot de passe est refuse', async () => {
    const { client, server } = await lab();
    await server.executeCommand('passwd -l carol');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
  }, 120_000);

  it('passwd -l : la cle entre toujours, UsePAM yes ne regarde que le compte', async () => {
    const { client, server } = await lab();
    await server.executeCommand('passwd -l carol');
    expect((await client.executeCommand(KEY)).trim()).toBe('carol');
  }, 120_000);

  it('passwd -l avec UsePAM no : sshd refuse le compte verrouille meme par la cle', async () => {
    const { client, server } = await lab();
    await server.executeCommand("sed -i 's/^UsePAM yes/UsePAM no/' /etc/ssh/sshd_config");
    await server.executeCommand('systemctl restart ssh');
    await server.executeCommand('passwd -l carol');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    expect(await server.executeCommand('cat /var/log/auth.log')).toContain('User carol not allowed because account is locked');
  }, 120_000);

  it('chage -E 0 : un compte expire est refuse par la cle, avec la ligne pam_unix', async () => {
    const { client, server } = await lab();
    await server.executeCommand('chage -E 0 carol');
    expect(await client.executeCommand(KEY)).toContain('Your account has expired; please contact your system administrator.');
    expect(await server.executeCommand('cat /var/log/auth.log')).toContain('pam_unix(sshd:account): account carol has expired (account expired)');
  }, 120_000);

  it('chage -E 0 : le mot de passe est refuse aussi', async () => {
    const { client, server } = await lab();
    await server.executeCommand('chage -E 0 carol');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
  }, 120_000);

  it('shell nologin : la cle entre, la session repond que le compte est indisponible', async () => {
    const { client, server } = await lab();
    await server.executeCommand('usermod -s /usr/sbin/nologin carol');
    expect(await client.executeCommand(KEY)).toContain('This account is currently not available.');
  }, 120_000);

  it('DenyUsers : ni la cle ni le mot de passe, journalise par sshd', async () => {
    const { client, server } = await lab();
    await server.executeCommand("sh -c 'echo DenyUsers carol >> /etc/ssh/sshd_config'");
    await server.executeCommand('systemctl restart ssh');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
    expect(await server.executeCommand('cat /var/log/auth.log')).toMatch(/User carol from 10\.95\.0\.10 not allowed because listed in DenyUsers/);
  }, 120_000);

  it('passwd -u rend le mot de passe', async () => {
    const { client, server } = await lab();
    await server.executeCommand('passwd -l carol');
    await server.executeCommand('passwd -u carol');
    expect((await client.executeCommand(PASSWORD)).trim()).toBe('carol');
  }, 120_000);
});

describe('serveur Windows', () => {
  const KEY = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id carol@10.96.0.20 whoami';
  const PASSWORD = 'sshpass -p Passw0rd! ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no carol@10.96.0.20 whoami';

  async function lab() {
    const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const server = new WindowsPC('windows-pc', 'WSRV');
    wire([client, server], '10.96.0');
    client.powerOn();
    server.powerOn();
    server.setCurrentUser('Administrator');
    await server.executeCommand('net user carol Passw0rd! /add');
    await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/id");
    const publicKey = (await client.executeCommand('cut -d" " -f1,2 ~/id.pub')).trim();
    await server.executeCommand('mkdir C:\\Users\\carol\\.ssh');
    await server.executeCommand(`echo ${publicKey}> C:\\Users\\carol\\.ssh\\authorized_keys`);
    await server.executeCommand('net start sshd');
    return { client, server };
  }

  it('TEMOIN: un compte ordinaire entre par la cle et par le mot de passe', async () => {
    const { client } = await lab();
    expect((await client.executeCommand(KEY)).trim().toLowerCase()).toContain('carol');
    expect((await client.executeCommand(PASSWORD)).trim().toLowerCase()).toContain('carol');
  }, 120_000);

  it('compte desactive : ni la cle (S4U refuse) ni le mot de passe', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net user carol /active:no');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
  }, 120_000);

  it('compte reactive : la cle entre de nouveau', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net user carol /active:no');
    await server.executeCommand('net user carol /active:yes');
    expect((await client.executeCommand(KEY)).toLowerCase()).toContain('carol');
  }, 120_000);

  it('Disable-LocalUser : meme refus par la cle', async () => {
    const { client, server } = await lab();
    await server.executeCommand('powershell -Command "Disable-LocalUser -Name carol"');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
  }, 120_000);

  it('net user /expires : la date est stockee et affichee', async () => {
    const { server } = await lab();
    await server.executeCommand('net user carol /expires:01/01/2000');
    expect(await server.executeCommand('net user carol')).toMatch(/Account expires\s+1\/1\/2000/);
    await server.executeCommand('net user carol /expires:never');
    expect(await server.executeCommand('net user carol')).toMatch(/Account expires\s+Never/);
  }, 120_000);

  it('net user /expires refuse une date invalide', async () => {
    const { server } = await lab();
    expect(await server.executeCommand('net user carol /expires:13/45/2000')).not.toContain('completed successfully');
  }, 120_000);

  it('compte expire : ni la cle ni le mot de passe', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net user carol /expires:01/01/2000');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
  }, 120_000);

  it('Set-LocalUser -AccountExpires : meme refus, et -AccountNeverExpires rend l acces', async () => {
    const { client, server } = await lab();
    await server.executeCommand('powershell -Command "Set-LocalUser -Name carol -AccountExpires (Get-Date \'2000-01-01\')"');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    await server.executeCommand('powershell -Command "Set-LocalUser -Name carol -AccountNeverExpires"');
    expect((await client.executeCommand(KEY)).toLowerCase()).toContain('carol');
  }, 120_000);

  it('compte verrouille par le seuil de blocage : la cle est refusee aussi', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net accounts /lockoutthreshold:2');
    const BAD = 'sshpass -p wrong ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no carol@10.96.0.20 whoami';
    await client.executeCommand(BAD);
    await client.executeCommand(BAD);
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
  }, 120_000);

  it('mot de passe expire (maxpwage) : le mot de passe est refuse, la cle entre (S4U ne presente aucun mot de passe)', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net accounts /maxpwage:1');
    const user = server.getUserManager().getUser('carol')!;
    user.passwordLastSet = new Date(Date.now() - 5 * 86_400_000);
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
    expect((await client.executeCommand(KEY)).toLowerCase()).toContain('carol');
  }, 120_000);

  it('DenyUsers : ni la cle ni le mot de passe', async () => {
    const { client, server } = await lab();
    await server.executeCommand('echo DenyUsers carol> C:\\sshd_config.new');
    await server.executeCommand('type C:\\ProgramData\\ssh\\sshd_config>> C:\\sshd_config.new');
    await server.executeCommand('copy /y C:\\sshd_config.new C:\\ProgramData\\ssh\\sshd_config');
    await server.executeCommand('net stop sshd');
    await server.executeCommand('net start sshd');
    expect(await client.executeCommand(KEY)).toContain('Permission denied');
    expect(await client.executeCommand(PASSWORD)).toContain('Permission denied');
  }, 120_000);
});
