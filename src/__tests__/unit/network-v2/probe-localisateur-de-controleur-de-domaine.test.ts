/**
 * Sonde — un controleur de domaine se TROUVE, il ne se nomme pas.
 *
 * Mesure d'origine : `Install-ADDSDomainController` exigeait `-Server`
 * (« missing mandatory parameters: Server »), et `Add-Computer` sans
 * `-Server` ne savait que resoudre le nom du domaine comme un hote. Une
 * vraie promotion interroge d'abord l'enregistrement SRV
 * `_ldap._tcp.dc._msdcs.<domaine>` que la promotion precedente a publie,
 * ordonne les candidats selon la RFC 2782, puis resout la cible. C'est le
 * seul mecanisme qui marche quand le DC source est sur un autre site :
 * l'operateur d'une branche ne connait pas l'adresse du siege, il connait
 * son serveur DNS.
 *
 * Discrimination `git stash` : 3 cas tombent avant le correctif —
 * « promeut DC02 sans qu on lui nomme le DC source », « joint le domaine
 * au DC que le SRV designe » et « refuse la promotion quand rien ne
 * designe le domaine » (avant, la refusion accusait un parametre
 * manquant ; elle nomme desormais la vraie cause, le domaine introuvable).
 *
 * Passent des deux cotes, et pourquoi :
 *  - « le SRV du localisateur est publie » — TEMOIN : prouve que la zone
 *    porte l'enregistrement, donc qu'un echec accuse le localisateur.
 *  - « promeut DC02 en nommant la source » — NON-REGRESSION : le chemin
 *    explicite ne doit rien perdre.
 *  - « joint un poste au domaine sans qu on lui nomme le DC » —
 *    NON-REGRESSION MESUREE : ce cas passait deja, l'enregistrement A du
 *    sommet de zone repondant a la place du SRV. Le localisateur ne le
 *    repare donc pas, il le fait passer par le mecanisme reel — et ce cas
 *    verifie que ce changement d'ordre ne casse rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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
const DSRM = '(ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force)';

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsServer | WindowsPC, l: string) => (await ps(d).processLine(l)).output.join('\n');

interface DeuxSites {
  dc1: WindowsServer;
  dc2: WindowsServer;
  pc: WindowsPC;
}

async function deuxSites(): Promise<DeuxSites> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const pc = new WindowsPC('windows-pc', 'PC-BR');
  const swHq = new GenericSwitch('switch-generic', 'SW-HQ', 8, 0, 0);
  const swBr = new GenericSwitch('switch-generic', 'SW-BR', 8, 0, 0);
  const rHq = new CiscoRouter('R-HQ', 0, 0);
  const rBr = new CiscoRouter('R-BR', 0, 0);
  for (const d of [dc1, dc2, pc, swHq, swBr, rHq, rBr]) d.powerOn();
  new Cable('hq-dc').connect(dc1.getPorts()[0], swHq.getPorts()[0]);
  new Cable('hq-gw').connect(rHq.getPort('GigabitEthernet0/0')!, swHq.getPorts()[7]);
  new Cable('dorsale').connect(rHq.getPort('GigabitEthernet0/1')!, rBr.getPort('GigabitEthernet0/1')!);
  new Cable('br-gw').connect(rBr.getPort('GigabitEthernet0/0')!, swBr.getPorts()[7]);
  new Cable('br-dc').connect(dc2.getPorts()[0], swBr.getPorts()[0]);
  new Cable('br-pc').connect(pc.getPorts()[0], swBr.getPorts()[1]);
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), M24);
  pc.getPorts()[0].configureIP(new IPAddress('192.168.20.30'), M24);
  dc1.setDefaultGateway(new IPAddress('192.168.10.1'));
  dc2.setDefaultGateway(new IPAddress('192.168.20.1'));
  pc.setDefaultGateway(new IPAddress('192.168.20.1'));
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end',
  ]) await rHq.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.10.0 255.255.255.0 10.0.0.1', 'end',
  ]) await rBr.executeCommand(c);
  for (const d of [dc1, dc2, pc]) d.setCurrentUser('Administrator');
  await run(dc1, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(dc1, `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);
  await run(dc2, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  return { dc1, dc2, pc };
}

describe('Sonde — le localisateur de DC lit le SRV publie par la promotion', () => {
  it('promeut DC02 sans qu on lui nomme le DC source', async () => {
    const { dc2 } = await deuxSites();
    await run(dc2, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
    const out = await run(dc2, `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);
    expect(out).not.toMatch(/missing mandatory parameters/i);
    expect(out).toContain('Success.');
  }, 60_000);

  it('joint le domaine au DC que le SRV designe', async () => {
    const { dc1, dc2 } = await deuxSites();
    await run(dc2, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
    await run(dc2, `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);
    const vuDepuisHq = await run(dc1, 'Get-ADDomainController -Filter * | Select-Object -ExpandProperty Name');
    expect(vuDepuisHq).toContain('DC01');
    const utilisateurs = await run(dc2, 'Get-ADUser -Filter * | Select-Object -ExpandProperty SamAccountName');
    expect(utilisateurs).toMatch(/krbtgt/i);
  }, 60_000);

  it('joint un poste au domaine sans qu on lui nomme le DC', async () => {
    const { dc1, pc } = await deuxSites();
    await run(pc, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
    const out = await run(pc, `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
    expect(out).not.toMatch(/could not be contacted/i);
    const comptes = await run(dc1, 'Get-ADComputer -Filter * | Select-Object -ExpandProperty Name');
    expect(comptes).toContain('PC-BR');
  }, 60_000);

  it('TEMOIN : le SRV du localisateur est publie et resolvable depuis la branche', async () => {
    const { dc2 } = await deuxSites();
    await run(dc2, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
    const out = await dc2.executeCommand(`nslookup -type=SRV _ldap._tcp.dc._msdcs.${DOMAINE} 192.168.10.10`);
    expect(out).toContain('DC01.mandeng.lan');
    expect(out).toContain('389');
  }, 60_000);

  it('promeut DC02 en nommant la source, comme avant', async () => {
    const { dc2 } = await deuxSites();
    const out = await run(dc2, `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}" -Server 192.168.10.10 -SafeModeAdministratorPassword ${DSRM} -Force:$true`);
    expect(out).toContain('Success.');
  }, 60_000);

  it('refuse la promotion quand rien ne designe le domaine', async () => {
    const { dc2 } = await deuxSites();
    const out = await run(dc2, `Install-ADDSDomainController -DomainName "absent.lan" -Credential "${ADMIN}" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);
    expect(out).toMatch(/does not exist or could not be contacted/i);
  }, 60_000);
});
