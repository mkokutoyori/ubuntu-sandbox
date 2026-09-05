/**
 * Un filtre annonce FILTRE, et une reponse inventee n'est pas une reponse.
 *
 * Mesure de depart, sur une machine Windows persistante et cablee :
 * `Get-NetTCPConnection -LocalPort 445` rendait les ONZE ecoutes de la
 * machine, `-LocalPort 99999` les rendait aussi, `Get-NetConnectionProfile`
 * declarait un profil « Internet » pour chacune des quatre cartes y compris
 * les trois sans cable, `Get-DnsClientServerAddress` ne montrait qu'IPv4,
 * `Get-NetIPInterface` annoncait `NlMtu 1500` pour tout le monde,
 * `Test-NetConnection zorglub.invalid` rendait `RemoteAddress` = le NOM et
 * `InterfaceAlias : Ethernet`, une interface que la machine n'a pas, et
 * `Resolve-DnsName 10.0.0.2` fabriquait `host-10-0-0-2.local`.
 *
 * Discrimine par `git stash` : 22 cas sur 27 tombent avant correctif.
 * Les CINQ qui passent des deux cotes sont nommes ici plutot que laisses a
 * deviner, chacun avec sa raison : le TEMOIN, dont c'est l'objet ;
 * `-InformationLevel Quiet`, la seule chose que `Test-NetConnection`
 * faisait deja juste ; et les trois cas de NON-REGRESSION
 * (`Get-NetIPAddress`, `Get-NetRoute`, `Get-NetFirewallRule`), qui gardent
 * l'extraction de la boucle de criteres et du lecteur de filtres que ce lot
 * met en commun — sans eux, la mise en commun ne serait garantie par
 * personne.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const interp = pc.getPowerShellInterpreter();
  const ps = (line: string): Promise<string> => Promise.resolve(interp.execute(line)) as Promise<string>;
  return { pc, srv, ps };
}

describe('les vues NetTCPIP / NetConnection / DnsClient filtrent pour de bon', () => {
  beforeEach(() => { /* setupGlobalState resets the registries */ });

  it('TEMOIN : une ecoute reelle de la machine parait dans Get-NetTCPConnection', async () => {
    const { ps } = await lab();
    const out = await ps('Get-NetTCPConnection');
    expect(out).toContain('LocalPort');
    expect(out).toMatch(/445/);
  });

  it('-LocalPort ne rend QUE le port demande', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-NetTCPConnection -LocalPort 445).LocalPort');
    expect(out.trim()).toBe('445');
  });

  it('-LocalPort sur un port que personne n ecoute REFUSE au lieu de tout rendre', async () => {
    const { ps } = await lab();
    const out = await ps('Get-NetTCPConnection -LocalPort 4444');
    expect(out).toContain("No MSFT_NetTCPConnection objects found with property 'LocalPort' equal to '4444'.");
  });

  it('-OwningProcess filtre', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-NetTCPConnection -OwningProcess 4).LocalPort');
    const ports = out.trim().split(/\s+/).filter(Boolean);
    expect(ports.length).toBeGreaterThan(0);
    const all = (await ps('(Get-NetTCPConnection).LocalPort')).trim().split(/\s+/).filter(Boolean);
    expect(ports.length).toBeLessThan(all.length);
  });

  it('un etat inconnu est REFUSE, et la liste des etats est celle de Windows', async () => {
    const { ps } = await lab();
    const out = await ps('Get-NetTCPConnection -State Zorglub');
    expect(out).toContain("Cannot validate argument on parameter 'State'");
    expect(out).toContain('Closed,Listen,SynSent,SynReceived,Established');
  });

  it('un port hors des seize bits est REFUSE', async () => {
    const { ps } = await lab();
    expect(await ps('Get-NetTCPConnection -LocalPort 99999'))
      .toContain('Cannot convert value "99999" to type "System.UInt16"');
  });

  it('un profil de connexion n existe que pour une carte CONNECTEE', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-NetConnectionProfile).InterfaceAlias');
    expect(out.trim()).toBe('Ethernet 0');
    expect(await ps('Get-NetConnectionProfile -InterfaceAlias "Ethernet 1"'))
      .toContain('No MSFT_NetConnectionProfile objects found');
  });

  it('la connectivite IPv4 suit la route par defaut au lieu d annoncer Internet', async () => {
    const { pc, ps } = await lab();
    expect(await ps('(Get-NetConnectionProfile).IPv4Connectivity')).toContain('LocalNetwork');
    pc.setDefaultGateway(new IPAddress('10.0.0.254'));
    expect(await ps('(Get-NetConnectionProfile).IPv4Connectivity')).toContain('Internet');
  });

  it('une interface sans adresse IPv6 est Disconnected et non NoTraffic', async () => {
    const { ps } = await lab();
    expect(await ps('(Get-NetConnectionProfile).IPv6Connectivity')).toContain('Disconnected');
  });

  it('la categorie DomainAuthenticated ne se POSE pas', async () => {
    const { ps } = await lab();
    const out = await ps('Set-NetConnectionProfile -InterfaceAlias "Ethernet 0"'
      + ' -NetworkCategory DomainAuthenticated -Confirm:$false');
    expect(out).toContain('The DomainAuthenticated network category cannot be set.');
  });

  it('une categorie inconnue est REFUSEE', async () => {
    const { ps } = await lab();
    expect(await ps('Set-NetConnectionProfile -InterfaceAlias "Ethernet 0"'
      + ' -NetworkCategory Zorglub -Confirm:$false'))
      .toContain("Cannot validate argument on parameter 'NetworkCategory'");
  });

  it('Set pose la categorie, et -PassThru rend le profil pose', async () => {
    const { ps } = await lab();
    const passed = await ps('(Set-NetConnectionProfile -InterfaceAlias "Ethernet 0"'
      + ' -NetworkCategory Private -PassThru -Confirm:$false).NetworkCategory');
    expect(passed.trim()).toBe('Private');
    expect((await ps('(Get-NetConnectionProfile).NetworkCategory')).trim()).toBe('Private');
  });

  it('Get-DnsClientServerAddress rend les DEUX familles', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0").AddressFamily');
    expect(out).toContain('IPv4');
    expect(out).toContain('IPv6');
  });

  it('-AddressFamily et -InterfaceIndex filtrent, et une famille inconnue est refusee', async () => {
    const { ps } = await lab();
    expect(await ps('(Get-DnsClientServerAddress -AddressFamily IPv6).AddressFamily'))
      .not.toContain('IPv4');
    expect((await ps('(Get-DnsClientServerAddress -InterfaceIndex 2).InterfaceAlias'))
      .trim().split(/\n/).every(l => l.trim() === 'Ethernet 0')).toBe(true);
    expect(await ps('Get-DnsClientServerAddress -AddressFamily Zorglub'))
      .toContain("Cannot validate argument on parameter 'AddressFamily'");
  });

  it('Test-NetConnection rend le temps de reponse dans les mots de Windows', async () => {
    const { ps } = await lab();
    const out = await ps('Test-NetConnection 10.0.0.2');
    expect(out).toContain('PingReplyDetails (RTT)');
    expect(out).toMatch(/PingReplyDetails \(RTT\)\s*:\s*\d+ ms/);
    expect(out).not.toMatch(/PingReplyDetails\s*:/);
  });

  it('un nom qui ne resout pas ne fabrique NI adresse NI interface', async () => {
    const { ps } = await lab();
    const out = await ps('Test-NetConnection zorglub.invalid | Format-List');
    expect(out).not.toContain('zorglub.invalid  \n');
    expect(out).not.toMatch(/RemoteAddress\s*:\s*zorglub/);
    expect(out).not.toMatch(/InterfaceAlias\s*:\s*Ethernet\s*$/m);
    expect(out).not.toMatch(/SourceAddress\s*:\s*0\.0\.0\.0/);
  });

  it('un port impossible et un service inconnu sont REFUSES', async () => {
    const { ps } = await lab();
    expect(await ps('Test-NetConnection 10.0.0.2 -Port 99999'))
      .toContain("Cannot validate argument on parameter 'Port'");
    expect(await ps('Test-NetConnection 10.0.0.2 -CommonTCPPort Zorglub'))
      .toContain('The argument does not belong to the set "HTTP,SMB,RDP,WINRM"');
  });

  it('-InformationLevel Quiet rend un booleen', async () => {
    const { ps } = await lab();
    expect((await ps('Test-NetConnection 10.0.0.2 -InformationLevel Quiet')).trim()).toBe('True');
  });

  it('un index explicite atteint une interface que la vue par defaut ne montre pas', async () => {
    const { ps } = await lab();
    const out = await ps('Get-NetIPConfiguration -InterfaceIndex 1');
    expect(out).toContain('Loopback Pseudo-Interface 1');
    expect(await ps('Get-NetIPConfiguration -InterfaceIndex 3'))
      .toContain('Ethernet 1');
  });

  it('-Detailed nomme la machine au lieu d une ligne vide', async () => {
    const { pc, ps } = await lab();
    const out = await ps('Get-NetIPConfiguration -Detailed');
    expect(out).toMatch(new RegExp(`ComputerName\\s*:\\s*${pc.getHostname()}`));
  });

  it('Resolve-DnsName ne fabrique plus de PTR pour une adresse que rien ne publie', async () => {
    const { ps } = await lab();
    const out = await ps('Resolve-DnsName 10.0.0.2');
    expect(out).not.toContain('host-10-0-0-2.local');
    expect(out).toContain('DNS name does not exist');
  });

  it('Get-NetIPInterface filtre, et lit le MTU du PORT', async () => {
    const { pc, ps } = await lab();
    pc.getPort('eth0')!.setMTU(9000);
    const out = await ps('Get-NetIPInterface -InterfaceAlias "Ethernet 0" -AddressFamily IPv4');
    expect(out).toContain('9000');
    expect(out).not.toContain('Ethernet 1');
  });

  it('un critere que ce simulateur ne sait pas juger est REFUSE en nommant la brique', async () => {
    const { ps } = await lab();
    expect(await ps('Get-NetIPInterface -Forwarding Enabled'))
      .toContain('The -Forwarding parameter is not implemented in this simulator');
  });

  it('le moteur historique ne porte plus aucune de ces vues', () => {
    expect(existsSync('src/network/devices/windows/PSNetCmdlets.ts')).toBe(false);
  });

  it('NON-REGRESSION : Get-NetIPAddress filtre toujours par interface', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-NetIPAddress -InterfaceAlias "Ethernet 0").IPAddress');
    expect(out.trim()).toBe('10.0.0.1');
  });

  it('NON-REGRESSION : Get-NetRoute filtre toujours par prefixe', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-NetRoute -DestinationPrefix 10.0.0.0/24).InterfaceAlias');
    expect(out.trim()).toBe('Ethernet 0');
  });

  it('NON-REGRESSION : Get-NetFirewallRule filtre toujours par nom', async () => {
    const { ps } = await lab();
    const noms = (await ps('(Get-NetFirewallRule).Name')).trim().split(/\n/)
      .map(l => l.trim()).filter(Boolean);
    expect(noms.length).toBeGreaterThan(1);
    const out = await ps(`(Get-NetFirewallRule -Name ${noms[0]}).Name`);
    expect(out.trim()).toBe(noms[0]);
  });
});
