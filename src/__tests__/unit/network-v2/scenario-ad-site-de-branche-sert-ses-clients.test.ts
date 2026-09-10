/**
 * Un site de branche a son PROPRE controleur de domaine — et c'est
 * mesurable sur le fil.
 *
 * Toute la raison d'etre d'un DC de branche est qu'un poste local cesse
 * de traverser le WAN pour ouvrir une session : il trouve un DC de SON
 * site et lui parle. Un simulateur qui promeut un second DC sans que rien
 * ne change sur la liaison inter-sites n'a promu qu'une etiquette. Ce
 * scenario compte donc les trames sur la dorsale, avant et apres.
 *
 *   SITE SIEGE 192.168.10.0/24          SITE BRANCHE 192.168.20.0/24
 *     DC01 .10                            DC02 .10   PC-BR .30
 *        \                                   \        /
 *        SW-HQ                                 SW-BR
 *          |                                     |
 *     R-HQ Gi0/0 .1                        R-BR Gi0/0 .1
 *     R-HQ Gi0/1 10.0.0.1/30            R-BR Gi0/1 10.0.0.2/30
 *              \______ dorsale ______/
 *
 * Les attentes ont ete ecrites A L'AVEUGLE, d'apres ce que fait une vraie
 * foret Active Directory : les sites et sous-reseaux declares par
 * l'administrateur, les enregistrements SRV que chaque promotion publie,
 * et le nom du DC que le client interroge.
 *
 * Discrimination `git stash` : 2 cas tombent avant le correctif — « publie
 * l enregistrement de localisateur PROPRE A SON SITE » (la promotion n'en
 * publiait aucun) et « nomme le DC de son site quand on lui demande lequel
 * il utilise » (`nltest /dsgetdc:` rendait l'ADRESSE du DC la ou un vrai
 * rend son NOM, avec un nom de site ecrit en dur, et la decouverte prenait
 * le PREMIER controleur de l'unite d'organisation au lieu de celui qu'on
 * interroge).
 *
 * Le cas « joint le domaine par le DC local, sans traverser la dorsale »
 * passait deja, et son TEMOIN — le meme poste, sans DC de branche, qui
 * lui traverse la dorsale — prouve que le compteur mesure bien quelque
 * chose. Une attente etait mienne et fausse : un vrai `repadmin
 * /showrepl` nomme ses voisins `Site\DC`, jamais par adresse.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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
const ADMIN = 'Administrator:DSRM@Mandeng2025!';
const DSRM = '(ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force)';
const SITE_SIEGE = 'Siege-Douala';
const SITE_BRANCHE = 'Branche-Kribi';

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsServer | WindowsPC, l: string) => (await ps(d).processLine(l)).output.join('\n');

interface Foret {
  dc1: WindowsServer;
  dc2: WindowsServer;
  pcBr: WindowsPC;
  dorsale: { compter(): number };
}

async function foret(avecDcDeBranche: boolean): Promise<Foret> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const pcBr = new WindowsPC('windows-pc', 'PC-BR');
  const swHq = new GenericSwitch('switch-generic', 'SW-HQ', 8, 0, 0);
  const swBr = new GenericSwitch('switch-generic', 'SW-BR', 8, 0, 0);
  const rHq = new CiscoRouter('R-HQ', 0, 0);
  const rBr = new CiscoRouter('R-BR', 0, 0);
  for (const d of [dc1, dc2, pcBr, swHq, swBr, rHq, rBr]) d.powerOn();

  new Cable('hq-dc').connect(dc1.getPorts()[0], swHq.getPorts()[0]);
  new Cable('hq-gw').connect(rHq.getPort('GigabitEthernet0/0')!, swHq.getPorts()[7]);
  new Cable('dorsale').connect(rHq.getPort('GigabitEthernet0/1')!, rBr.getPort('GigabitEthernet0/1')!);
  new Cable('br-gw').connect(rBr.getPort('GigabitEthernet0/0')!, swBr.getPorts()[7]);
  new Cable('br-dc').connect(dc2.getPorts()[0], swBr.getPorts()[0]);
  new Cable('br-pc').connect(pcBr.getPorts()[0], swBr.getPorts()[1]);

  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), M24);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), M24);
  pcBr.getPorts()[0].configureIP(new IPAddress('192.168.20.30'), M24);
  dc1.setDefaultGateway(new IPAddress('192.168.10.1'));
  dc2.setDefaultGateway(new IPAddress('192.168.20.1'));
  pcBr.setDefaultGateway(new IPAddress('192.168.20.1'));

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

  for (const d of [dc1, dc2, pcBr]) d.setCurrentUser('Administrator');
  await run(dc1, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(dc1, `Install-ADDSForest -DomainName "${DOMAINE}" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);

  await run(dc1, `New-ADReplicationSite -Name "${SITE_SIEGE}"`);
  await run(dc1, `New-ADReplicationSite -Name "${SITE_BRANCHE}"`);
  await run(dc1, `New-ADReplicationSubnet -Name "192.168.10.0/24" -Site "${SITE_SIEGE}"`);
  await run(dc1, `New-ADReplicationSubnet -Name "192.168.20.0/24" -Site "${SITE_BRANCHE}"`);

  if (avecDcDeBranche) {
    await run(dc2, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
    await run(dc2, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
    await run(dc2, `Install-ADDSDomainController -DomainName "${DOMAINE}" -Credential "${ADMIN}" -SafeModeAdministratorPassword ${DSRM} -Force:$true`);
  }

  const port = rHq.getPort('GigabitEthernet0/1')!;
  let vues = 0;
  port.attachTap(() => { vues++; });
  return { dc1, dc2, pcBr, dorsale: { compter: () => vues } };
}

describe('Scenario — le site de branche sert ses propres clients', () => {
  describe('la foret connait ses deux sites', () => {
    it('liste les deux sites declares', async () => {
      const { dc1 } = await foret(false);
      const out = await run(dc1, 'Get-ADReplicationSite -Filter * | Select-Object -ExpandProperty Name');
      expect(out).toContain(SITE_SIEGE);
      expect(out).toContain(SITE_BRANCHE);
    }, 120_000);

    it('rattache chaque sous-reseau a son site', async () => {
      const { dc1 } = await foret(false);
      const out = await run(dc1, 'Get-ADReplicationSubnet -Filter * | Format-List');
      expect(out).toContain('192.168.20.0/24');
      expect(out).toContain(SITE_BRANCHE);
    }, 120_000);

    it('place le DC de branche dans le site de la branche', async () => {
      const { dc1 } = await foret(true);
      const out = await run(dc1, 'Get-ADDomainController -Filter * | Select-Object Name,Site | Format-Table');
      expect(out).toContain('DC02');
      expect(out).toContain(SITE_BRANCHE);
    }, 120_000);
  });

  describe('les deux controleurs se connaissent', () => {
    it('le siege voit les deux controleurs de domaine', async () => {
      const { dc1 } = await foret(true);
      const out = await run(dc1, 'Get-ADDomainController -Filter * | Select-Object -ExpandProperty Name');
      expect(out).toContain('DC01');
      expect(out).toContain('DC02');
    }, 120_000);

    it('la branche nomme le siege comme voisin entrant', async () => {
      const { dc2 } = await foret(true);
      const out = await run(dc2, 'repadmin /showrepl');
      expect(out).toContain('INBOUND NEIGHBORS');
      expect(out).toContain('DC01');
      expect(out).not.toContain('(nothing yet)');
    }, 120_000);
  });

  describe('le DC de branche se publie dans le DNS', () => {
    it('publie son propre enregistrement de localisateur', async () => {
      const { dc2 } = await foret(true);
      const out = await run(dc2, `Resolve-DnsName -Type SRV _ldap._tcp.dc._msdcs.${DOMAINE} -Server 192.168.20.10`);
      expect(out).toContain('DC02');
    }, 120_000);

    it('publie l enregistrement de localisateur PROPRE A SON SITE', async () => {
      const { dc2 } = await foret(true);
      const out = await run(dc2, `Resolve-DnsName -Type SRV _ldap._tcp.${SITE_BRANCHE}._sites.dc._msdcs.${DOMAINE} -Server 192.168.20.10`);
      expect(out).toContain('DC02');
    }, 120_000);
  });

  describe('un poste de la branche prefere le DC de son site', () => {
    it('joint le domaine par le DC local, sans traverser la dorsale', async () => {
      const infra = await foret(true);
      await run(infra.pcBr, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.20.10');
      const avant = infra.dorsale.compter();
      const out = await run(infra.pcBr, `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      expect(out).not.toMatch(/could not be contacted/i);
      expect(infra.dorsale.compter() - avant).toBe(0);
    }, 120_000);

    it('nomme le DC de son site quand on lui demande lequel il utilise', async () => {
      const infra = await foret(true);
      await run(infra.pcBr, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.20.10');
      await run(infra.pcBr, `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      const out = await infra.pcBr.executeCommand(`nltest /dsgetdc:${DOMAINE}`);
      expect(out).toContain('DC02');
    }, 120_000);
  });

  describe('TEMOIN — sans DC de branche, le meme poste traverse la dorsale', () => {
    it('joint le domaine par le siege, et cela se compte sur la liaison', async () => {
      const infra = await foret(false);
      await run(infra.pcBr, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 192.168.10.10');
      const avant = infra.dorsale.compter();
      const out = await run(infra.pcBr, `Add-Computer -DomainName "${DOMAINE}" -Credential "${ADMIN}"`);
      expect(out).not.toMatch(/could not be contacted/i);
      expect(infra.dorsale.compter() - avant).toBeGreaterThan(0);
    }, 120_000);
  });
});
