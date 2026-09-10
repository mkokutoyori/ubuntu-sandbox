/**
 * Sonde — `Resolve-DnsName -Type` pose VRAIMENT la question demandee.
 *
 * Mesure d'origine : la cmdlet acceptait `-Type` et ne s'en servait
 * jamais. Toute question partait en A. Sur le controleur de domaine
 * lui-meme, `nslookup -type=SRV _ldap._tcp.dc._msdcs.<domaine>` lisait
 * l'enregistrement du localisateur de DC pendant que
 * `Resolve-DnsName -Type SRV` sur la MEME machine, a la MEME seconde,
 * repondait « DNS name does not exist » : deux vues d'une seule zone qui
 * se contredisent (regle 3), et un critere accepte puis ignore (regle 6).
 * La resolution inverse avait le meme defaut sous une autre forme : elle
 * repondait de memoire — localhost pour 127.x, « n'existe pas » pour
 * tout le reste — sans jamais interroger la zone inverse que la
 * promotion publie pourtant.
 *
 * Discrimination `git stash` : 4 cas tombent avant le correctif —
 * « SRV », « les deux vues nomment la meme cible », « un type inconnu est
 * refuse » et « l adresse publiee a un PTR ».
 *
 * Passent des deux cotes, et pourquoi :
 *  - « nslookup lit le SRV » — TEMOIN : prouve que la zone porte bien
 *    l'enregistrement, donc qu'un echec cote PowerShell accuse la cmdlet
 *    et non le laboratoire.
 *  - « sans -Type, la reponse reste une adresse » — NON-REGRESSION.
 *  - « une adresse que rien ne publie n a pas de PTR » — NON-REGRESSION :
 *    la reponse etait bonne par accident, elle doit le rester en
 *    interrogeant vraiment.
 *  - « 127.0.0.1 nomme toujours localhost » — STRUCTUREL : la boucle
 *    locale se lit sans reseau, avant comme apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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
const LOCALISATEUR = `_ldap._tcp.dc._msdcs.${DOMAINE}`;

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsServer | WindowsPC, l: string) => (await ps(d).processLine(l)).output.join('\n');

interface Labo { dc: WindowsServer; pc: WindowsPC }

async function labo(): Promise<Labo> {
  const dc = new WindowsServer('DC01');
  const pc = new WindowsPC('windows-pc', 'PC1');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  for (const d of [dc, pc, sw]) d.powerOn();
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-pc').connect(pc.getPorts()[0], sw.getPorts()[1]);
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
  pc.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), M24);
  dc.setCurrentUser('Administrator');
  pc.setCurrentUser('Administrator');
  await run(dc, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(dc, `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true`);
  await run(pc, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
  return { dc, pc };
}

describe('Sonde — Resolve-DnsName honore le type demande', () => {
  it('rend le SRV du localisateur de DC avec ses quatre champs', async () => {
    const { pc } = await labo();
    const out = await run(pc, `Resolve-DnsName -Type SRV ${LOCALISATEUR}`);
    expect(out).toContain('SRV');
    expect(out).toMatch(/NameTarget\s*:\s*DC01\.mandeng\.lan/);
    expect(out).toMatch(/Port\s*:\s*389/);
    expect(out).toMatch(/Priority\s*:\s*0/);
    expect(out).toMatch(/Weight\s*:\s*100/);
  }, 60_000);

  it('nomme la meme cible que nslookup, sur la meme machine', async () => {
    const { pc } = await labo();
    const parCmd = await pc.executeCommand(`nslookup -type=SRV ${LOCALISATEUR} 192.168.10.10`);
    const parPs = await run(pc, `Resolve-DnsName -Type SRV ${LOCALISATEUR}`);
    expect(parCmd).toContain('DC01.mandeng.lan');
    expect(parPs).toContain('DC01.mandeng.lan');
  }, 60_000);

  it('refuse un type que le moteur DNS ne sait pas encoder au lieu de repondre une adresse', async () => {
    const { pc } = await labo();
    const out = await run(pc, `Resolve-DnsName -Type ZORGLUB ${DOMAINE}`);
    expect(out).toMatch(/not a record type this DNS engine can encode/);
    expect(out).not.toContain('192.168.10.10');
  }, 60_000);

  it('rend le PTR reellement publie pour une adresse de la zone inverse', async () => {
    const { pc } = await labo();
    const out = await run(pc, 'Resolve-DnsName 192.168.10.10');
    expect(out).toMatch(/Type\s*:\s*PTR/);
    expect(out).toMatch(/NameHost\s*:\s*DC01\.mandeng\.lan/);
  }, 60_000);

  it('TEMOIN : nslookup lit deja ce SRV dans la zone', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(`nslookup -type=SRV ${LOCALISATEUR} 192.168.10.10`);
    expect(out).toContain('389');
    expect(out).toContain('DC01.mandeng.lan');
  }, 60_000);

  it('sans -Type, la reponse reste une adresse', async () => {
    const { pc } = await labo();
    const out = await run(pc, `Resolve-DnsName ${DOMAINE}`);
    expect(out).toMatch(/Type\s*:\s*A\b/);
    expect(out).toContain('192.168.10.10');
  }, 60_000);

  it('une adresse que rien ne publie n a toujours pas de PTR', async () => {
    const { pc } = await labo();
    const out = await run(pc, 'Resolve-DnsName 192.168.10.77');
    expect(out).toContain('77.10.168.192.in-addr.arpa : DNS name does not exist');
  }, 60_000);

  it('127.0.0.1 nomme toujours localhost', async () => {
    const { pc } = await labo();
    const out = await run(pc, 'Resolve-DnsName 127.0.0.1');
    expect(out).toContain('1.0.0.127.in-addr.arpa');
    expect(out).toContain('localhost');
  }, 60_000);
});
