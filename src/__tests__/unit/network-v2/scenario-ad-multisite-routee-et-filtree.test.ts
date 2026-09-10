/**
 * Un domaine Windows sur une infrastructure d'ENTREPRISE : deux sites,
 * des routeurs, des commutateurs et un pare-feu entre les deux.
 *
 * Les ateliers AD de ce depot vivent tous sur un LAN PLAT — un
 * commutateur, tout le monde dans le meme /24. Rien n'y prouve que le
 * dialogue de domaine traverse VRAIMENT le reseau : sur un lien unique,
 * un raccourci en memoire et une trame sur le fil sont indiscernables.
 * Ce scenario route et FILTRE le chemin, ce qui rend la difference
 * observable (regle 4).
 *
 *   SITE HQ 192.168.10.0/24            SITE BRANCHE 192.168.20.0/24
 *     DC01 .10  PC-HQ .30                 DC02 .10  PC-BR .30
 *          \\      /                            \\      /
 *           SW-HQ                                SW-BR
 *             |                                    |
 *        R-HQ Gi0/0 .1                        R-BR Gi0/0 .1
 *        R-HQ Gi0/1 10.0.0.1/30            R-BR Gi0/1 10.0.1.2/30
 *                \\                              /
 *              FGT port1 10.0.0.2   port2 10.0.1.1
 *
 * Les attentes ont ete ecrites A L'AVEUGLE, d'apres ce qu'une vraie
 * infrastructure fait — pas d'apres ce que ce simulateur rendait alors.
 * Cinq cas sont tombes a la premiere execution, et chacun a designe un
 * defaut reel : la reponse de replication (15505 octets binaires) ne
 * franchissait aucun routeur, `Resolve-DnsName -Type SRV` ignorait le
 * type demande, et `Install-ADDSDomainController` exigeait qu'on lui
 * NOMME le DC source. Deux attentes etaient miennes et fausses : sans
 * `/P`, `repadmin /syncall` TIRE vers le DC nomme au lieu de pousser
 * vers ses partenaires ; et un DC en cours de promotion se pointe sur le
 * serveur DNS du domaine, il ne s'ecrit pas une ligne dans `hosts`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const M24 = new SubnetMask('255.255.255.0');
const DOMAINE = 'mandeng.lan';
const ADMIN = 'Administrator:DSRM@Mandeng2025!';

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

interface Infra {
  dc1: WindowsServer; dc2: WindowsServer;
  pcHq: WindowsPC; pcBr: WindowsPC;
  rHq: CiscoRouter; rBr: CiscoRouter; fgt: FortiGate;
  lienWan: { compter(): number };
}

async function batir(): Promise<Infra> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const pcHq = new WindowsPC('windows-pc', 'PC-HQ');
  const pcBr = new WindowsPC('windows-pc', 'PC-BR');
  const swHq = new GenericSwitch('switch-generic', 'SW-HQ', 8, 0, 0);
  const swBr = new GenericSwitch('switch-generic', 'SW-BR', 8, 0, 0);
  const rHq = new CiscoRouter('R-HQ', 0, 0);
  const rBr = new CiscoRouter('R-BR', 0, 0);
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  for (const d of [dc1, dc2, pcHq, pcBr, swHq, swBr, rHq, rBr, fgt]) d.powerOn();

  new Cable('hq-dc').connect(dc1.getPorts()[0], swHq.getPort('eth0')!);
  new Cable('hq-pc').connect(pcHq.getPorts()[0], swHq.getPort('eth1')!);
  new Cable('hq-gw').connect(rHq.getPort('GigabitEthernet0/0')!, swHq.getPort('eth7')!);
  new Cable('wan-a').connect(rHq.getPort('GigabitEthernet0/1')!, fgt.getPort('port1')!);
  new Cable('wan-b').connect(fgt.getPort('port2')!, rBr.getPort('GigabitEthernet0/1')!);
  new Cable('br-gw').connect(rBr.getPort('GigabitEthernet0/0')!, swBr.getPort('eth7')!);
  new Cable('br-dc').connect(dc2.getPorts()[0], swBr.getPort('eth0')!);
  new Cable('br-pc').connect(pcBr.getPorts()[0], swBr.getPort('eth1')!);

  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
  pcHq.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), M24);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), M24);
  pcBr.getPorts()[0].configureIP(new IPAddress('192.168.20.30'), M24);
  dc1.setDefaultGateway(new IPAddress('192.168.10.1'));
  pcHq.setDefaultGateway(new IPAddress('192.168.10.1'));
  dc2.setDefaultGateway(new IPAddress('192.168.20.1'));
  pcBr.setDefaultGateway(new IPAddress('192.168.20.1'));

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.20.0 255.255.255.0 10.0.0.2',
    'ip route 10.0.1.0 255.255.255.252 10.0.0.2', 'end',
  ]) await rHq.executeCommand(cmd);
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.2 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.10.0 255.255.255.0 10.0.1.1',
    'ip route 10.0.0.0 255.255.255.252 10.0.1.1', 'end',
  ]) await rBr.executeCommand(cmd);

  const sh = fgt.getShell();
  for (const line of [
    'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.0.0.2 255.255.255.252', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.0.1.1 255.255.255.252', 'set allowaccess ping', 'next',
    'end',
    'config router static',
    'edit 1', 'set dst 192.168.10.0 255.255.255.0', 'set gateway 10.0.0.1', 'set device "port1"', 'next',
    'edit 2', 'set dst 192.168.20.0 255.255.255.0', 'set gateway 10.0.1.2', 'set device "port2"', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'next',
    'edit 2', 'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'next',
    'end',
  ]) sh.execute(line);

  for (const d of [dc1, dc2, pcHq, pcBr]) d.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc1), `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);

  const port = rHq.getPort('GigabitEthernet0/1')!;
  let vues = 0;
  port.attachTap(() => { vues++; });
  return { dc1, dc2, pcHq, pcBr, rHq, rBr, fgt, lienWan: { compter: () => vues } };
}

describe("Scenario — domaine Windows sur une infra multi-site routee et filtree", () => {
  describe('le socle reseau porte les deux sites', () => {
    it('un poste de la branche joint le routeur de son site, puis celui du siege', async () => {
      const { pcBr } = await batir();
      expect(await pcBr.executeCommand('ping -n 1 192.168.20.1')).toMatch(/Received = 1/);
      expect(await pcBr.executeCommand('ping -n 1 192.168.10.1')).toMatch(/Received = 1/);
    }, 120_000);

    it('un poste de la branche joint le DC du siege, a travers deux routeurs et le pare-feu', async () => {
      const { pcBr } = await batir();
      expect(await pcBr.executeCommand('ping -n 1 192.168.10.10')).toMatch(/Received = 1/);
    }, 120_000);

    it('`tracert` depuis la branche montre bien les sauts intermediaires', async () => {
      const { pcBr } = await batir();
      const out = await pcBr.executeCommand('tracert -d 192.168.10.10');
      expect(out).toContain('192.168.20.1');
      expect(out).toContain('192.168.10.10');
    }, 120_000);
  });

  describe('le service de domaine repond a travers le reseau', () => {
    it('le DC ecoute LDAP sur 389, et la branche atteint ce port', async () => {
      const { pcBr } = await batir();
      const out = await run(ps(pcBr), 'Test-NetConnection -ComputerName 192.168.10.10 -Port 389');
      expect(out).toMatch(/TcpTestSucceeded\s*:\s*True/);
    }, 120_000);

    it('le DC ecoute le port de replication 135, et la branche l atteint', async () => {
      const { pcBr } = await batir();
      const out = await run(ps(pcBr), 'Test-NetConnection -ComputerName 192.168.10.10 -Port 135');
      expect(out).toMatch(/TcpTestSucceeded\s*:\s*True/);
    }, 120_000);

    it('le DC sert le DNS du domaine a un client distant', async () => {
      const { pcBr } = await batir();
      await run(ps(pcBr), 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
      const out = await run(ps(pcBr), `Resolve-DnsName ${DOMAINE}`);
      expect(out).toContain('192.168.10.10');
    }, 120_000);

    it('un client trouve son DC par l enregistrement SRV, comme une vraie machine', async () => {
      const { pcBr } = await batir();
      await run(ps(pcBr), 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
      const out = await run(ps(pcBr), `Resolve-DnsName -Type SRV _ldap._tcp.dc._msdcs.${DOMAINE}`);
      expect(out).toContain('DC01');
    }, 120_000);
  });

  describe('la jonction au domaine traverse vraiment le reseau', () => {
    it('un poste de la BRANCHE joint le domaine servi au siege', async () => {
      const { pcBr, dc1 } = await batir();
      await run(ps(pcBr), `Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 ${DOMAINE}\`n192.168.10.10 DC01.${DOMAINE}"`);
      const out = await run(ps(pcBr), `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      expect(out).not.toMatch(/error|impossible|failed/i);
      const comptes = await run(ps(dc1), 'Get-ADComputer -Filter * | Select-Object -ExpandProperty Name');
      expect(comptes).toContain('PC-BR');
    }, 120_000);

    it('la jonction MET DES TRAMES sur le lien WAN', async () => {
      const infra = await batir();
      await run(ps(infra.pcBr), `Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 ${DOMAINE}\`n192.168.10.10 DC01.${DOMAINE}"`);
      const avant = infra.lienWan.compter();
      await run(ps(infra.pcBr), `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      expect(infra.lienWan.compter() - avant).toBeGreaterThan(0);
    }, 120_000);

    it('pare-feu fermant LDAP : la jonction ECHOUE, preuve que le dialogue passe par lui', async () => {
      const infra = await batir();
      await run(ps(infra.pcBr), `Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 ${DOMAINE}\`n192.168.10.10 DC01.${DOMAINE}"`);
      const sh = infra.fgt.getShell();
      for (const line of [
        'config firewall policy', 'edit 2', 'set action deny', 'next', 'end',
      ]) sh.execute(line);
      const out = await run(ps(infra.pcBr), `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      expect(out).toMatch(/error|impossible|failed|introuvable|not be contacted/i);
      const comptes = await run(ps(infra.dc1), 'Get-ADComputer -Filter * | Select-Object -ExpandProperty Name');
      expect(comptes).not.toContain('PC-BR');
    }, 120_000);
  });

  describe('le second controleur de domaine et la replication', () => {
    async function promouvoirDc2(dc2: WindowsServer, avecServer: boolean): Promise<string> {
      await run(ps(dc2), 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
      await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      const serveur = avecServer ? ' -Server 192.168.10.10' : '';
      return run(ps(dc2), `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}"${serveur} -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);
    }

    it('DC02 se promeut SANS qu on lui nomme le DC source, comme sur une vraie machine', async () => {
      const { dc2 } = await batir();
      const out = await promouvoirDc2(dc2, false);
      expect(out).not.toMatch(/missing mandatory parameters/i);
      const roles = await run(ps(dc2), 'Get-ADDomainController -Filter * | Select-Object -ExpandProperty Name');
      expect(roles).toContain('DC02');
    }, 120_000);

    it('DC02 promu en nommant le DC source rejoint bien le domaine', async () => {
      const { dc2 } = await batir();
      const out = await promouvoirDc2(dc2, true);
      expect(out).not.toMatch(/could not be contacted|Logon failure|not installed|synchronization with .* failed/i);
      const roles = await run(ps(dc2), 'Get-ADDomainController -Filter * | Select-Object -ExpandProperty Name');
      expect(roles).toContain('DC02');
    }, 120_000);

    it('la promotion du second DC MET DES TRAMES sur le lien WAN', async () => {
      const infra = await batir();
      const avant = infra.lienWan.compter();
      await promouvoirDc2(infra.dc2, true);
      expect(infra.lienWan.compter() - avant).toBeGreaterThan(0);
    }, 120_000);

    it('un utilisateur cree au siege se replique vers la branche', async () => {
      const { dc1, dc2 } = await batir();
      await promouvoirDc2(dc2, true);
      await run(ps(dc1), 'New-ADUser -Name "jdupont" -SamAccountName "jdupont" -AccountPassword (ConvertTo-SecureString "P@ssw0rd2025!" -AsPlainText -Force) -Enabled $true');
      const pousse = await run(ps(dc1), 'repadmin /syncall /P');
      expect(pousse).toContain('notified to sync now: successful');
      const vuBranche = await run(ps(dc2), 'Get-ADUser -Filter * | Select-Object -ExpandProperty SamAccountName');
      expect(vuBranche).toContain('jdupont');
    }, 120_000);
  });

  describe('TEMOIN a plat : la meme promotion sur un seul commutateur', () => {
    it('sur un LAN PLAT, DC02 se promeut et se replique', async () => {
      const dc1 = new WindowsServer('DC01');
      const dc2 = new WindowsServer('DC02');
      const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
      for (const d of [dc1, dc2, sw]) d.powerOn();
      new Cable('p1').connect(dc1.getPorts()[0], sw.getPort('eth0')!);
      new Cable('p2').connect(dc2.getPorts()[0], sw.getPort('eth1')!);
      dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
      dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), M24);
      dc1.setCurrentUser('Administrator');
      dc2.setCurrentUser('Administrator');
      await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      await run(ps(dc1), `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);
      await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      const out = await run(ps(dc2), `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}" -Server 192.168.10.10 -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);
      expect(out).not.toMatch(/synchronization with .* failed/i);
    }, 120_000);
  });

  describe('TEMOIN routee SANS pare-feu : deux routeurs seulement', () => {
    it('a travers deux routeurs et sans pare-feu, DC02 se promeut et se synchronise', async () => {
      const dc1 = new WindowsServer('DC01');
      const dc2 = new WindowsServer('DC02');
      const r1 = new CiscoRouter('R1', 0, 0);
      const r2 = new CiscoRouter('R2', 0, 0);
      const sw1 = new GenericSwitch('switch-generic', 'S1', 8, 0, 0);
      const sw2 = new GenericSwitch('switch-generic', 'S2', 8, 0, 0);
      for (const d of [dc1, dc2, r1, r2, sw1, sw2]) d.powerOn();
      new Cable('x1').connect(dc1.getPorts()[0], sw1.getPort('eth0')!);
      new Cable('x2').connect(r1.getPort('GigabitEthernet0/0')!, sw1.getPort('eth7')!);
      new Cable('x3').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
      new Cable('x4').connect(r2.getPort('GigabitEthernet0/0')!, sw2.getPort('eth7')!);
      new Cable('x5').connect(dc2.getPorts()[0], sw2.getPort('eth0')!);
      dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
      dc2.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), M24);
      dc1.setDefaultGateway(new IPAddress('192.168.10.1'));
      dc2.setDefaultGateway(new IPAddress('192.168.20.1'));
      for (const cmd of ['enable', 'configure terminal',
        'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
        'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
        'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end']) await r1.executeCommand(cmd);
      for (const cmd of ['enable', 'configure terminal',
        'interface GigabitEthernet0/0', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
        'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
        'ip route 192.168.10.0 255.255.255.0 10.0.0.1', 'end']) await r2.executeCommand(cmd);
      dc1.setCurrentUser('Administrator');
      dc2.setCurrentUser('Administrator');
      expect(await dc2.executeCommand('ping -n 1 192.168.10.10')).toMatch(/Received = 1/);
      await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      await run(ps(dc1), `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);
      await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
      const out = await run(ps(dc2), `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}" -Server 192.168.10.10 -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);
      expect(out).not.toMatch(/synchronization with .* failed/i);
    }, 120_000);
  });

  describe('l ouverture de session d un utilisateur du domaine', () => {
    it('un poste joint authentifie un utilisateur du domaine par Kerberos', async () => {
      const { dc1, pcBr } = await batir();
      await run(ps(pcBr), `Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 ${DOMAINE}\`n192.168.10.10 DC01.${DOMAINE}"`);
      await run(ps(dc1), 'New-ADUser -Name "jdupont" -SamAccountName "jdupont" -AccountPassword (ConvertTo-SecureString "P@ssw0rd2025!" -AsPlainText -Force) -Enabled $true');
      await run(ps(pcBr), `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      const out = await run(ps(pcBr), 'Test-ComputerSecureChannel');
      expect(out.trim()).toMatch(/True/);
    }, 120_000);
  });
});
