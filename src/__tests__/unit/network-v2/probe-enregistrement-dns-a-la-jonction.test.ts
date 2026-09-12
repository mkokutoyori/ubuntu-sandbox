/**
 * Sonde — une machine qui joint le domaine s'INSCRIT dans son DNS.
 *
 * Sur un vrai domaine, un poste ou un serveur qui vient d'etre joint
 * enregistre son enregistrement A dans la zone du domaine, par une mise a
 * jour dynamique (RFC 2136). C'est ce qui fait qu'apres la jonction,
 * `\\SRV-FICHIERS\partage` se resout pour tout le monde sans que personne
 * n'edite un fichier `hosts`.
 *
 * Ici, la jonction n'inscrivait rien, et `ipconfig /registerdns`
 * annonçait « Registration of the DNS resource records for all adapters
 * of this computer has been initiated » sans rien enregistrer : le
 * message exact de Windows, pour une action qui n'avait pas lieu. Un
 * laboratoire DFS de ce depot a d'ailleurs du contourner ce manque par
 * une ligne `hosts` ajoutee a la main — c'est ce contournement qui a
 * rendu le defaut visible.
 *
 * Le serveur DNS de ce depot SAIT deja traiter une mise a jour dynamique
 * (`WindowsDnsServerRole.handleUpdate`), et un client sait deja en
 * emettre une sur le fil (`sendDynamicUpdate`, ce que `nsupdate` utilise
 * cote Linux). Ce qui manquait, c'est que Windows la pose.
 *
 * Les attentes sont ecrites d'apres le comportement d'un vrai domaine.
 *
 * Discrimination `git stash` : 3 des 6 cas tombent. Les trois autres sont
 * nommes plutot que laisses a decouvrir — « met des trames sur le fil »
 * (la jonction en posait deja, ce cas ne separe donc pas l'inscription du
 * reste du dialogue), « n'invente rien pour une machine non jointe »
 * (STRUCTUREL : la regle est d'inscrire ce qui appartient au domaine, et
 * rien d'autre) et le TEMOIN du DC resolvable des sa promotion, qui
 * prouve que la zone repond — sans quoi trois echecs de resolution
 * mesureraient un DNS muet plutot qu'une inscription absente.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
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
const DSRM = '(ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force)';

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsPC, l: string) => (await ps(d).processLine(l)).output.join('\n');

interface Labo { dc: WindowsServer; membre: WindowsServer; poste: WindowsPC; wan: { compter(): number } }

async function labo(): Promise<Labo> {
  const dc = new WindowsServer('DC01');
  const membre = new WindowsServer('SRV-FICHIERS');
  const poste = new WindowsPC('windows-pc', 'PC-01');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  for (const d of [dc, membre, poste, sw]) d.powerOn();
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-srv').connect(membre.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-pc').connect(poste.getPorts()[0], sw.getPorts()[2]);
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
  membre.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), M24);
  poste.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), M24);
  for (const d of [dc, membre, poste]) d.setCurrentUser('Administrator');

  await run(dc, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(dc, `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);

  // Les deux machines pointent sur le DNS du domaine, comme un vrai
  // administrateur les configure AVANT de les joindre.
  for (const d of [membre, poste]) {
    await run(d, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
  }
  let vues = 0;
  membre.getPorts()[0].attachTap(() => { vues++; });
  return { dc, membre, poste, wan: { compter: () => vues } };
}

describe('Sonde — la jonction au domaine inscrit la machine dans le DNS', () => {
  it('rend le serveur membre resolvable par son nom, sans fichier hosts', async () => {
    const { membre, poste } = await labo();
    await run(membre, `Add-Computer -DomainName "${DOMAINE}" -Credential "Administrator:DSRM@Mandeng2025!" -Force`);
    const out = await run(poste, `Resolve-DnsName SRV-FICHIERS.${DOMAINE}`);
    expect(out).toContain('192.168.10.20');
  }, 120_000);

  it('inscrit l enregistrement dans la zone que le DC sert', async () => {
    const { dc, membre } = await labo();
    await run(membre, `Add-Computer -DomainName "${DOMAINE}" -Credential "Administrator:DSRM@Mandeng2025!" -Force`);
    const zone = await run(dc, `Get-DnsServerResourceRecord -ZoneName ${DOMAINE} | Format-Table`);
    expect(zone).toMatch(/SRV-FICHIERS/i);
    expect(zone).toContain('192.168.10.20');
  }, 120_000);

  it('met des trames sur le fil pour s inscrire', async () => {
    const { membre, wan } = await labo();
    const avant = wan.compter();
    await run(membre, `Add-Computer -DomainName "${DOMAINE}" -Credential "Administrator:DSRM@Mandeng2025!" -Force`);
    expect(wan.compter() - avant).toBeGreaterThan(0);
  }, 120_000);

  it('ipconfig /registerdns reinscrit vraiment', async () => {
    const { dc, membre } = await labo();
    await run(membre, `Add-Computer -DomainName "${DOMAINE}" -Credential "Administrator:DSRM@Mandeng2025!" -Force`);
    await run(dc, `Remove-DnsServerResourceRecord -ZoneName ${DOMAINE} -Name SRV-FICHIERS -RRType A -Force`);
    expect(await run(dc, `Get-DnsServerResourceRecord -ZoneName ${DOMAINE}`)).not.toMatch(/SRV-FICHIERS/i);
    await membre.executeCommand('ipconfig /registerdns');
    expect(await run(dc, `Get-DnsServerResourceRecord -ZoneName ${DOMAINE}`)).toMatch(/SRV-FICHIERS/i);
  }, 120_000);

  it('n invente rien pour une machine qui n a joint aucun domaine', async () => {
    const { dc, poste } = await labo();
    await poste.executeCommand('ipconfig /registerdns');
    expect(await run(dc, `Get-DnsServerResourceRecord -ZoneName ${DOMAINE}`)).not.toMatch(/PC-01/i);
  }, 120_000);

  it('TEMOIN : le DC lui-meme est resolvable des sa promotion', async () => {
    const { poste } = await labo();
    expect(await run(poste, `Resolve-DnsName DC01.${DOMAINE}`)).toContain('192.168.10.10');
  }, 120_000);
});
