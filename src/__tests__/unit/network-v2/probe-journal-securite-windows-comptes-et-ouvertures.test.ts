/**
 * Le journal Security de Windows dit QUI a fait QUOI, et comment la session
 * SSH a vraiment été ouverte.
 *
 * L'AUTORITE : pour les ouvertures de session, le code de Win32-OpenSSH
 * (contrib/win32/win32compat/win32_usertoken_utils.c) -- le mot de passe passe
 * par LogonUserExExW(LOGON32_LOGON_NETWORK_CLEARTEXT), donc le type 8 ; la clé
 * par LsaLogonUser S4U (type Network = 3), processus d'ouverture « sshd »,
 * paquet MSV1_0 ; ni l'un ni l'autre ne transmet l'adresse du client à la LSA,
 * qui reste « - » (c'est le journal OpenSSH/Operational qui la porte). Un
 * sshd qui refuse un utilisateur de lui-même (DenyUsers, mauvaise clé) ne
 * demande rien à Windows : aucun événement de sécurité. Pour les champs des
 * événements 4624/4625/4634/4672/4719/4720-4726/4731-4734/4738/4740/4767 :
 * le schéma Microsoft-Windows-Security-Auditing (noms d'EventData et
 * sous-statuts NTSTATUS) ; le texte exact des messages n'a pas pu être relu à
 * la source (learn.microsoft.com injoignable d'ici).
 *
 * MESURE DE DEPART (contre le dernier commit, git stash du code source) :
 * 15 cas sur 22 tombent. Les sessions SSH étaient journalisées en type 10
 * (qui est RDP), un compte désactivé, expiré ou verrouillé donnait le même
 * 4625 qu'un mauvais mot de passe, l'EventData de 4624/4625 sans processus,
 * paquet d'authentification ni adresse, le sujet de tout événement de gestion
 * de compte était « Administrator » quel que soit l'acteur, aucun 4719, 4767
 * ni 4738 sur changement d'attribut, un 4672 seulement pour les comptes
 * nommés « admin », et le journal OpenSSH/Operational portait le port 22 du
 * SERVEUR à la place du port source du client.
 * Passent des deux côtés : les deux TEMOINS (le lab produit un 4624 pour un
 * mot de passe correct et un 4720 pour un compte créé), le SID/domaine du
 * 4624, l'absence de 4625 sur DenyUsers (non-régression), le message du 4720,
 * 4732/4733 avec le SID du membre et l'expression Get-WinEvent (structure déjà
 * en place).
 *
 * Limite : le message exact de chaque événement est écrit de mémoire du
 * schéma Microsoft-Windows-Security-Auditing ; le texte n'a pas pu être relu à
 * la source. Aucune commande n'atteint encore SamrChangePasswordUser (le
 * 4723 passe par l'API du gestionnaire de comptes), `net user` étant un
 * NetUserSetInfo, donc toujours un 4724.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function wire(devices: Array<{ getPorts(): Array<{ configureIP(ip: IPAddress, mask: SubnetMask): void }> }>): void {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  devices.forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(`10.97.0.${10 + index * 10}`), mask);
  });
}

async function lab() {
  const client = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const server = new WindowsPC('windows-pc', 'WSRV');
  wire([client, server]);
  client.powerOn();
  server.powerOn();
  server.setCurrentUser('Administrator');
  await server.executeCommand('net user erin Passw0rd! /add');
  await client.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/id");
  const publicKey = (await client.executeCommand('cut -d" " -f1,2 ~/id.pub')).trim();
  await server.executeCommand('mkdir C:\\Users\\erin\\.ssh');
  await server.executeCommand(`echo ${publicKey}> C:\\Users\\erin\\.ssh\\authorized_keys`);
  await server.executeCommand('net start sshd');
  return { client, server };
}

const PASSWORD = (secret: string) =>
  `sshpass -p ${secret} ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no erin@10.97.0.20 whoami`;
const KEY = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id erin@10.97.0.20 whoami';

const events = async (server: WindowsPC, id: number): Promise<string> =>
  String(await server.executeCmdCommand(`wevtutil qe Security /q:"*[System[EventID=${id}]]" /rd:true /f:xml`));

const data = (xml: string, name: string): string =>
  new RegExp(`<Data Name='${name}'>([^<]*)</Data>`).exec(xml)?.[1] ?? '';

const newest = (xml: string): string => xml.split('</Event>')[0] ?? '';

const count = (xml: string): number => xml.split('</Event>').length - 1;

describe('ouvertures de session SSH', () => {
  it('TEMOIN: un mot de passe correct produit un 4624 pour le compte', async () => {
    const { client, server } = await lab();
    expect((await client.executeCommand(PASSWORD('Passw0rd!'))).toLowerCase()).toContain('erin');
    expect(data(newest(await events(server, 4624)), 'TargetUserName')).toBe('erin');
  }, 120_000);

  it('le mot de passe ouvre un logon de type 8 (NetworkCleartext) par sshd.exe, paquet Negotiate', async () => {
    const { client, server } = await lab();
    await client.executeCommand(PASSWORD('Passw0rd!'));
    const xml = newest(await events(server, 4624));
    expect(data(xml, 'LogonType')).toBe('8');
    expect(data(xml, 'ProcessName')).toBe('C:\\Windows\\System32\\OpenSSH\\sshd.exe');
    expect(data(xml, 'LogonProcessName')).toBe('Advapi');
    expect(data(xml, 'AuthenticationPackageName')).toBe('Negotiate');
  }, 120_000);

  it('la clé ouvre un logon S4U de type 3, processus « sshd », paquet MSV1_0', async () => {
    const { client, server } = await lab();
    await client.executeCommand(KEY);
    const xml = newest(await events(server, 4624));
    expect(data(xml, 'LogonType')).toBe('3');
    expect(data(xml, 'LogonProcessName')).toBe('sshd');
    expect(data(xml, 'AuthenticationPackageName')).toBe('MICROSOFT_AUTHENTICATION_PACKAGE_V1_0');
  }, 120_000);

  it('l\'adresse du client n\'est pas transmise à la LSA : « - », et le journal OpenSSH la porte', async () => {
    const { client, server } = await lab();
    await client.executeCommand(PASSWORD('Passw0rd!'));
    const xml = newest(await events(server, 4624));
    expect(data(xml, 'IpAddress')).toBe('-');
    expect(data(xml, 'IpPort')).toBe('-');
    const operational = String(await server.executeCmdCommand('wevtutil qe OpenSSH/Operational /rd:true /c:10 /f:text'));
    expect(operational).toMatch(/Accepted password for erin from 10\.97\.0\.10 port 3\d{4} ssh2/);
  }, 120_000);

  it('le 4624 porte le SID, le domaine et un sujet SYSTEM', async () => {
    const { client, server } = await lab();
    await client.executeCommand(PASSWORD('Passw0rd!'));
    const xml = newest(await events(server, 4624));
    expect(data(xml, 'TargetUserSid')).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/);
    expect(data(xml, 'TargetDomainName')).toBe('WSRV');
    expect(data(xml, 'SubjectUserSid')).toBe('S-1-5-18');
    expect(data(xml, 'SubjectUserName')).toBe('WSRV$');
  }, 120_000);

  it('4634 reprend le Logon ID et le type du 4624 qui l\'a ouvert', async () => {
    const { client, server } = await lab();
    await client.executeCommand(PASSWORD('Passw0rd!'));
    const logon = newest(await events(server, 4624));
    const logoff = newest(await events(server, 4634));
    expect(data(logoff, 'TargetLogonId')).toBe(data(logon, 'TargetLogonId'));
    expect(data(logoff, 'LogonType')).toBe('8');
  }, 120_000);

  it('un mauvais mot de passe donne un 4625 de type 8, sous-statut 0xC000006A', async () => {
    const { client, server } = await lab();
    await client.executeCommand(PASSWORD('wrong'));
    const xml = newest(await events(server, 4625));
    expect(data(xml, 'LogonType')).toBe('8');
    expect(data(xml, 'Status')).toBe('0xC000006D');
    expect(data(xml, 'SubStatus')).toBe('0xC000006A');
    expect(data(xml, 'TargetUserSid')).toMatch(/^S-1-5-21-/);
  }, 120_000);

  it('un compte inconnu n\'atteint pas Windows par SSH (sshd refuse seul) ; une ouverture locale donne 0xC0000064 et le SID nul', async () => {
    const { client, server } = await lab();
    const before = count(await events(server, 4625));
    await client.executeCommand('sshpass -p x ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no ghost@10.97.0.20 whoami');
    expect(count(await events(server, 4625))).toBe(before);
    server.getUserManager().checkPassword('ghost', 'x');
    const xml = newest(await events(server, 4625));
    expect(data(xml, 'SubStatus')).toBe('0xC0000064');
    expect(data(xml, 'TargetUserSid')).toBe('S-1-0-0');
  }, 120_000);

  it('chaque cause d\'échec a son Status : désactivé, expiré, verrouillé', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net user erin /active:no');
    await client.executeCommand(PASSWORD('Passw0rd!'));
    expect(data(newest(await events(server, 4625)), 'Status')).toBe('0xC0000072');
    await server.executeCommand('net user erin /active:yes');
    await server.executeCommand('net user erin /expires:01/01/2000');
    await client.executeCommand(PASSWORD('Passw0rd!'));
    expect(data(newest(await events(server, 4625)), 'Status')).toBe('0xC0000193');
    await server.executeCommand('net user erin /expires:never');
    await server.executeCommand('net accounts /lockoutthreshold:2');
    await client.executeCommand(PASSWORD('x'));
    await client.executeCommand(PASSWORD('x'));
    await client.executeCommand(PASSWORD('Passw0rd!'));
    expect(data(newest(await events(server, 4625)), 'Status')).toBe('0xC0000234');
  }, 120_000);

  it('le message du 4625 donne la raison en toutes lettres', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net user erin /active:no');
    await client.executeCommand(PASSWORD('Passw0rd!'));
    const text = String(await server.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4625]]" /rd:true /c:1 /f:text'));
    expect(text).toContain('Failure Reason:\t\tAccount currently disabled.');
    expect(text).toContain('Sub Status:\t\t0x0');
  }, 120_000);

  it('une clé refusée sur un compte désactivé est un 4625 de type 3', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net user erin /active:no');
    await client.executeCommand(KEY);
    const xml = newest(await events(server, 4625));
    expect(data(xml, 'LogonType')).toBe('3');
    expect(data(xml, 'Status')).toBe('0xC0000072');
  }, 120_000);

  it('une mauvaise clé ou DenyUsers ne demandent rien à Windows : aucun 4625', async () => {
    const { client, server } = await lab();
    await server.executeCommand('echo DenyUsers erin> C:\\sshd_config.new');
    await server.executeCommand('type C:\\ProgramData\\ssh\\sshd_config>> C:\\sshd_config.new');
    await server.executeCommand('copy /y C:\\sshd_config.new C:\\ProgramData\\ssh\\sshd_config');
    await server.executeCommand('net stop sshd');
    await server.executeCommand('net start sshd');
    const before = count(await events(server, 4625));
    await client.executeCommand(PASSWORD('Passw0rd!'));
    await client.executeCommand(KEY);
    expect(count(await events(server, 4625))).toBe(before);
  }, 120_000);

  it('un administrateur quelconque reçoit un 4672 à l\'ouverture', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net localgroup Administrators erin /add');
    await client.executeCommand(PASSWORD('Passw0rd!'));
    const xml = newest(await events(server, 4672));
    expect(data(xml, 'SubjectUserName')).toBe('erin');
    expect(data(xml, 'PrivilegeList')).toContain('SeDebugPrivilege');
  }, 120_000);
});

describe('gestion des comptes', () => {
  const run = async (server: WindowsPC, line: string): Promise<string> =>
    (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

  it('TEMOIN: net user /add produit un 4720 qui nomme la cible', async () => {
    const { server } = await lab();
    expect(data(newest(await events(server, 4720)), 'TargetUserName')).toBe('erin');
  }, 120_000);

  it('le sujet est le compte qui agit, avec son SID complet et son Logon ID', async () => {
    const { server } = await lab();
    await server.executeCommand('net localgroup Administrators erin /add');
    server.getUserManager().setCurrentUser('erin');
    await server.executeCommand('net user erin /fullname:"Erin Doe"');
    const xml = newest(await events(server, 4738));
    expect(data(xml, 'SubjectUserName')).toBe('erin');
    expect(data(xml, 'SubjectUserSid')).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/);
    expect(data(xml, 'SubjectLogonId')).toMatch(/^0x[0-9a-f]+$/i);
    expect(data(xml, 'DisplayName')).toBe('Erin Doe');
  }, 120_000);

  it('net user réinitialise le mot de passe (4724) ; seul un changement avec l\'ancien est un 4723', async () => {
    const { server } = await lab();
    await server.executeCommand('net user erin NewPassw0rd1!');
    expect(data(newest(await events(server, 4724)), 'SubjectUserName')).toBe('Administrator');
    expect(count(await events(server, 4723))).toBe(0);
    server.getUserManager().setCurrentUser('erin');
    expect(server.getUserManager().changePassword('erin', 'wrong', 'Another1Passw0rd!')).toContain('not correct');
    expect(count(await events(server, 4723))).toBe(0);
    expect(server.getUserManager().changePassword('erin', 'NewPassw0rd1!', 'Another1Passw0rd!')).toBe('');
    const own = newest(await events(server, 4723));
    expect(data(own, 'TargetUserName')).toBe('erin');
    expect(data(own, 'SubjectUserName')).toBe('erin');
  }, 120_000);

  it('4738 accompagne un changement de date d\'expiration', async () => {
    const { server } = await lab();
    await server.executeCommand('net user erin /expires:01/01/2031');
    expect(data(newest(await events(server, 4738)), 'AccountExpires')).toBe('1/1/2031');
  }, 120_000);

  it('4767 consigne le déverrouillage d\'un compte bloqué', async () => {
    const { client, server } = await lab();
    await server.executeCommand('net accounts /lockoutthreshold:2');
    await client.executeCommand(PASSWORD('x'));
    await client.executeCommand(PASSWORD('x'));
    expect(data(newest(await events(server, 4740)), 'TargetUserName')).toBe('erin');
    await server.executeCommand('net user erin /active:yes');
    expect(data(newest(await events(server, 4767)), 'TargetUserName')).toBe('erin');
  }, 120_000);

  it('un membre ajouté puis retiré d\'Administrators laisse 4732 puis 4733, avec le SID du membre', async () => {
    const { server } = await lab();
    await server.executeCommand('net localgroup Administrators erin /add');
    await server.executeCommand('net localgroup Administrators erin /delete');
    const added = newest(await events(server, 4732));
    const removed = newest(await events(server, 4733));
    expect(data(added, 'TargetUserName')).toBe('Administrators');
    expect(data(added, 'TargetSid')).toBe('S-1-5-32-544');
    expect(data(added, 'MemberSid')).toMatch(/^S-1-5-21-/);
    expect(data(removed, 'MemberSid')).toBe(data(added, 'MemberSid'));
  }, 120_000);

  it('auditpol /set écrit un 4719 qui dit ce qui a changé', async () => {
    const { server } = await lab();
    await server.executeCommand('auditpol /set /subcategory:"File Share" /success:enable /failure:enable');
    const xml = newest(await events(server, 4719));
    expect(data(xml, 'SubcategoryName')).toBe('File Share');
    expect(data(xml, 'AuditPolicyChanges')).toBe('Success Added, Failure Added');
    expect(data(xml, 'SubjectUserName')).toBe('Administrator');
  }, 120_000);

  it('le message du 4720 reprend la structure de Windows (sujet, nouveau compte, attributs)', async () => {
    const { server } = await lab();
    const text = String(await server.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4720]]" /rd:true /c:1 /f:text'));
    expect(text).toMatch(/A user account was created\.\n\nSubject:\n\tSecurity ID:\t\tS-1-5-21-\d+-\d+-\d+-500\n\tAccount Name:\t\tAdministrator\n\tAccount Domain:\t\tWSRV/);
    expect(text).toContain('New Account:\n\tSecurity ID:');
    expect(text).toContain('Attributes:\n\tSAM Account Name:\terin');
  }, 120_000);

  it('Get-WinEvent expose les mêmes champs structurés', async () => {
    const { server } = await lab();
    const out = await run(server,
      "Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4720 } | Select-Object -First 1 | ForEach-Object { $x = [xml]$_.ToXml(); ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'TargetUserName' }).'#text' }");
    expect(out).toBe('erin');
  }, 120_000);
});
