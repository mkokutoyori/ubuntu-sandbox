/*
 * Windows DHCP Server failover (Microsoft implementation of the IETF DHCP
 * failover draft, TCP 647): load balance and hot standby, scope and lease
 * replication, MCLT-capped leases while the partner is away, PartnerDown by
 * hand and by AutoStateTransition, resynchronisation, shared-secret
 * authentication and Kerberos-authenticated administration.
 *
 * Lab: DC1 (10.0.0.10) is the domain controller of google.com, DHCP1
 * (10.0.0.11) and DHCP2 (10.0.0.12) are member DHCP servers, six Windows
 * clients ask for a lease on the same switch. Every partner exchange, setup
 * included, is a real frame on TCP 647; setup is authorised by a Kerberos
 * AP-REQ that the partner checks against its own computer-account key.
 *
 * Discrimination: the feature is new, so before the change the file cannot
 * load (the failover module and cmdlets do not exist) and all 28 cases fall.
 * That proves little, so the cases were also measured by mutation on the
 * finished code: giving both servers the same client-hash threshold (a defect
 * met while writing: no client left unserved but two servers answered one)
 * drops 2 cases (the two "répartition de charge" splits); returning the
 * configured lease while the partner is away drops the MCLT case; accepting
 * PartnerDown from any state drops the "n est accepté qu en
 * CommunicationInterrupted" case. Cases that pass under those mutations pass
 * for a structural reason: the three TEMOIN cases are lab witnesses (the
 * clients really lease with no relationship, the lease really lasts 8 days
 * uncapped, a correctly signed message is really accepted), and the 80/20
 * split only checks the ordering of the two halves.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { sendFailoverMessage, signMessage } from '@/network/dhcp/failover/FailoverWire';
import type { LabDevice } from '../new_firewall/userLab';
import { ADMIN_CREDENTIAL, DSRM, promoteDomainController } from '../new_firewall/userLabDomain';

const DC1 = '10.0.0.10';
const DHCP1 = '10.0.0.11';
const DHCP2 = '10.0.0.12';
const CLIENTS = 6;

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (d: WindowsServer | WindowsPC, line: string) => (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

interface Lab { dc1: WindowsServer; dhcp1: WindowsServer; dhcp2: WindowsServer; clients: WindowsPC[]; sw: GenericSwitch; snoop: WindowsPC }

async function lab(options: { failover?: string } = {}): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw1', 16, 0, 0);
  const dc1 = new WindowsServer('DC1');
  const dhcp1 = new WindowsServer('DHCP1');
  const dhcp2 = new WindowsServer('DHCP2');
  const clients = Array.from({ length: CLIENTS }, (_, i) => new WindowsPC('windows-pc', `PC${i + 1}`));
  const snoop = new WindowsPC('windows-pc', 'SNOOP');
  const mask = new SubnetMask('255.255.255.0');
  [dc1, dhcp1, dhcp2].forEach((server, i) => {
    new Cable(`s${i}`).connect(server.getPorts()[0], sw.getPorts()[i]);
    server.getPorts()[0].configureIP(new IPAddress([DC1, DHCP1, DHCP2][i]), mask);
  });
  clients.forEach((client, i) => new Cable(`c${i}`).connect(client.getPorts()[0], sw.getPorts()[3 + i]));
  new Cable('snoop').connect(snoop.getPorts()[0], sw.getPorts()[3 + CLIENTS]);
  snoop.getPorts()[0].configureIP(new IPAddress('10.0.0.66'), mask);

  await promoteDomainController(dc1 as unknown as LabDevice);
  for (const server of [dhcp1, dhcp2]) {
    server.setCurrentUser('Administrator');
    await run(server, `Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${DC1}`);
    await run(server, `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}"`);
    await run(server, 'Install-WindowsFeature DHCP');
    await run(server, 'Add-DhcpServerInDC');
  }
  await run(dc1, 'Add-DnsServerResourceRecordA -ZoneName google.com -Name DHCP1 -IPv4Address 10.0.0.11');
  await run(dc1, 'Add-DnsServerResourceRecordA -ZoneName google.com -Name DHCP2 -IPv4Address 10.0.0.12');
  await run(dhcp1, 'Add-DhcpServerv4Scope -Name Lan -StartRange 10.0.0.100 -EndRange 10.0.0.199 -SubnetMask 255.255.255.0 -LeaseDuration 8.00:00:00');
  await run(dhcp1, 'Set-DhcpServerv4OptionValue -ScopeId Lan -OptionId 3 -Value 10.0.0.1');
  expect(dhcp1.logonDomain('GOOGLE\\Administrator', DSRM).ok).toBe(true);
  if (options.failover !== undefined) {
    const out = await run(dhcp1, `Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Lan ${options.failover}`);
    expect(out).toBe('');
  }
  return { dc1, dhcp1, dhcp2, clients, sw, snoop };
}

async function leaseAll(clients: WindowsPC[]): Promise<void> {
  for (const client of clients) await client.executeCommand('ipconfig /renew');
}

const leases = async (server: WindowsServer) => run(server, 'Get-DhcpServerv4Lease -ScopeId Lan | ForEach-Object { $_.IPAddress }');
const addressesOf = async (server: WindowsServer) => (await leases(server)).split('\n').map(l => l.trim()).filter(l => /^\d+\.\d+\.\d+\.\d+$/.test(l));
const remainingSeconds = async (server: WindowsServer) =>
  (await run(server, 'Get-DhcpServerv4Lease -ScopeId Lan | ForEach-Object { ($_.LeaseExpiryTime - (Get-Date)).TotalSeconds }'))
    .split('\n').map(line => Number(line.trim())).filter(value => Number.isFinite(value));
const last = (address: string) => Number(address.split('.')[3]);

describe('témoin du laboratoire', () => {
  it('TEMOIN : sans relation, un seul serveur sert et les clients louent une adresse', async () => {
    const { dhcp1, dhcp2, clients } = await lab();
    await leaseAll(clients);
    expect((await addressesOf(dhcp1)).length).toBe(CLIENTS);
    expect(await run(dhcp2, 'Get-DhcpServerv4Scope')).toBe('');
  }, 120000);
});

describe('création de la relation', () => {
  it('Add-DhcpServerv4Failover réplique l étendue, ses options et pose la relation des deux côtés', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '-LoadBalancePercent 50' });
    const onPrimary = await run(dhcp1, 'Get-DhcpServerv4Failover -Name F1');
    expect(onPrimary).toMatch(/Mode\s+:\s+LoadBalance/);
    expect(onPrimary).toMatch(/State\s+:\s+Normal/);
    expect(onPrimary).toMatch(/PrimaryServerName\s+:\s+DHCP1/);
    expect(onPrimary).toMatch(/SecondaryServerName\s+:\s+DHCP2/);
    const onPartner = await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1');
    expect(onPartner).toMatch(/State\s+:\s+Normal/);
    expect(await run(dhcp2, 'Get-DhcpServerv4Scope')).toContain('Lan');
    expect(await run(dhcp2, 'Get-DhcpServerv4OptionValue -ScopeId Lan')).toContain('10.0.0.1');
  }, 120000);

  it('un utilisateur de domaine non administrateur ne peut pas créer la relation et rien n est posé', async () => {
    const { dhcp1, dhcp2, dc1 } = await lab();
    await run(dc1, 'New-ADUser -Name mdupuis -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
    expect(dhcp1.logonDomain('GOOGLE\\mdupuis', 'Passw0rd!').ok).toBe(true);
    const out = await run(dhcp1, 'Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Lan');
    expect(out).toMatch(/Access is denied/);
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover')).toBe('');
    expect(await run(dhcp2, 'Get-DhcpServerv4Scope')).toBe('');
  }, 120000);

  it('sans session de domaine il n y a pas de ticket : accès refusé', async () => {
    const { dhcp1, dhcp2 } = await lab();
    dhcp1.setCurrentUser('Administrator');
    const out = await run(dhcp1, 'Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Lan');
    expect(out).toMatch(/Access is denied/);
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover')).toBe('');
  }, 120000);

  it('un partenaire injoignable : la relation n est pas créée', async () => {
    const { dhcp1, dhcp2 } = await lab();
    dhcp2.getPorts()[0].setAdminDown(true);
    const out = await run(dhcp1, 'Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Lan');
    expect(out).toMatch(/could not be reached|could not be resolved/);
    expect(await run(dhcp1, 'Get-DhcpServerv4Failover')).toBe('');
  }, 120000);

  it('des paramètres hors bornes sont refusés', async () => {
    const { dhcp1 } = await lab();
    expect(await run(dhcp1, 'Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Lan -LoadBalancePercent 100')).toMatch(/between 1 and 99/);
    expect(await run(dhcp1, 'Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Lan -MaxClientLeadTime 00:00:30')).toMatch(/at least one minute/);
    expect(await run(dhcp1, 'Add-DhcpServerv4Failover -Name F1 -PartnerServer DHCP2 -ScopeId Nope')).toMatch(/does not exist/);
  }, 120000);

  it('une étendue déjà membre d une relation ne peut pas être supprimée', async () => {
    const { dhcp1 } = await lab({ failover: '' });
    expect(await run(dhcp1, 'Remove-DhcpServerv4Scope -ScopeId Lan')).toMatch(/belongs to the failover relationship "F1"/);
    expect(await run(dhcp1, 'Get-DhcpServerv4Scope')).toContain('Lan');
  }, 120000);
});

describe('répartition de charge', () => {
  it('chaque client est servi par un seul serveur, dans la moitié de plage de ce serveur, et les deux serveurs voient tous les baux', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-LoadBalancePercent 50' });
    await leaseAll(clients);
    await settle();
    const held1 = await addressesOf(dhcp1);
    const held2 = await addressesOf(dhcp2);
    expect(held1.length).toBe(CLIENTS);
    expect(new Set(held1).size).toBe(CLIENTS);
    expect([...held1].sort()).toEqual([...held2].sort());
    const assigned = clients.map(client => client.getPorts()[0].getIPAddress()?.toString() ?? '');
    expect([...assigned].sort()).toEqual([...held1].sort());
    const fromPrimaryHalf = assigned.filter(ip => last(ip) < 150);
    const fromSecondaryHalf = assigned.filter(ip => last(ip) >= 150);
    expect(fromPrimaryHalf.length).toBeGreaterThan(0);
    expect(fromSecondaryHalf.length).toBeGreaterThan(0);
    expect(fromPrimaryHalf.length + fromSecondaryHalf.length).toBe(CLIENTS);
  }, 180000);

  it('les offres de chaque serveur ne portent que sur ses propres clients : aucun client n est servi deux fois', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-LoadBalancePercent 50' });
    await leaseAll(clients);
    await settle();
    const acks = (server: WindowsServer) => (server.getDhcpServerRole() as unknown as { engine: { getStats(): { acks: number } } }).engine.getStats().acks;
    expect(acks(dhcp1) + acks(dhcp2)).toBe(CLIENTS);
    expect(acks(dhcp1)).toBeGreaterThan(0);
    expect(acks(dhcp2)).toBeGreaterThan(0);
  }, 180000);

  it('le partage 80/20 fait servir davantage de clients par le primaire', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-LoadBalancePercent 80' });
    await leaseAll(clients);
    await settle();
    const held = await addressesOf(dhcp1);
    const fromPrimary = held.filter(ip => last(ip) < 180).length;
    const fromSecondary = held.filter(ip => last(ip) >= 180).length;
    expect(fromPrimary).toBeGreaterThan(fromSecondary);
    expect(held.length).toBe((await addressesOf(dhcp2)).length);
  }, 180000);
});

describe('serveur en attente', () => {
  it('l actif sert tous les clients, le standby aucun tant que la relation est Normal', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-ServerRole Active -ReservePercent 10' });
    await leaseAll(clients);
    await settle();
    expect(await run(dhcp1, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/Mode\s+:\s+HotStandby/);
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/ServerRole\s+:\s+Standby/);
    const held = await addressesOf(dhcp1);
    expect(held.length).toBe(CLIENTS);
    expect(held.every(ip => last(ip) < 190)).toBe(true);
    expect((await addressesOf(dhcp2)).length).toBe(CLIENTS);
  }, 180000);

  it('quand l actif tombe, le standby sert les nouveaux clients depuis la réserve', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-ServerRole Active -ReservePercent 10' });
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    await settle();
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+CommunicationInterrupted/);
    await leaseAll(clients.slice(0, 2));
    const held = await addressesOf(dhcp2);
    expect(held.length).toBe(2);
    expect(held.every(ip => last(ip) >= 190)).toBe(true);
  }, 180000);
});

describe('perte de contact, MCLT et PartnerDown', () => {
  it('sans nouvelles du partenaire : CommunicationInterrupted, bail plafonné au MCLT', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-LoadBalancePercent 50 -MaxClientLeadTime 01:00:00' });
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    await settle();
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+CommunicationInterrupted/);
    await leaseAll(clients);
    const remaining = await remainingSeconds(dhcp2);
    expect(remaining.length).toBeGreaterThan(0);
    for (const seconds of remaining) expect(seconds).toBeLessThanOrEqual(3600 + 5);
  }, 180000);

  it('TEMOIN : sans relation le même bail n est pas plafonné et dure 8 jours', async () => {
    const { dhcp1, clients } = await lab();
    await leaseAll(clients.slice(0, 1));
    const remaining = await remainingSeconds(dhcp1);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toBeGreaterThan(7 * 86400);
  }, 120000);

  it('Set-DhcpServerv4Failover -PartnerDown n est accepté qu en CommunicationInterrupted', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '' });
    expect(await run(dhcp2, 'Set-DhcpServerv4Failover -Name F1 -PartnerDown')).toMatch(/can only be declared from CommunicationInterrupted/);
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    await settle();
    expect(await run(dhcp2, 'Set-DhcpServerv4Failover -Name F1 -PartnerDown')).toBe('');
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+PartnerDown/);
  }, 180000);

  it('après PartnerDown et un MCLT écoulé, le survivant rend la durée normale et toute la plage', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-MaxClientLeadTime 01:00:00' });
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    await settle();
    await run(dhcp2, 'Set-DhcpServerv4Failover -Name F1 -PartnerDown');
    dhcp2.advanceTime(2 * 3600_000);
    await leaseAll(clients);
    const held = await addressesOf(dhcp2);
    expect(held.length).toBe(CLIENTS);
    expect((await remainingSeconds(dhcp2)).every(seconds => seconds > 7 * 86400)).toBe(true);
  }, 180000);

  it('AutoStateTransition : PartnerDown tout seul après StateSwitchInterval', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '-AutoStateTransition $true -StateSwitchInterval 00:10:00' });
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    await settle();
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+CommunicationInterrupted/);
    dhcp2.advanceTime(5 * 60_000);
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+CommunicationInterrupted/);
    dhcp2.advanceTime(6 * 60_000);
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+PartnerDown/);
  }, 180000);

  it('sans AutoStateTransition la relation reste CommunicationInterrupted', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '-StateSwitchInterval 00:10:00' });
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    dhcp2.advanceTime(3600_000);
    await settle();
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+CommunicationInterrupted/);
  }, 180000);

  it('le retour du partenaire : resynchronisation des baux puis retour à Normal', async () => {
    const { dhcp1, dhcp2, clients } = await lab({ failover: '-LoadBalancePercent 50' });
    dhcp1.getPorts()[0].setAdminDown(true);
    dhcp2.advanceTime(60_000);
    await settle();
    await leaseAll(clients.slice(0, 3));
    const during = await addressesOf(dhcp2);
    expect(during.length).toBe(3);
    expect(await addressesOf(dhcp1)).toEqual([]);
    dhcp1.getPorts()[0].setAdminDown(false);
    dhcp2.advanceTime(20_000);
    await settle();
    await settle();
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/State\s+:\s+Normal/);
    expect([...(await addressesOf(dhcp1))].sort()).toEqual([...during].sort());
  }, 180000);
});

describe('administration de la relation', () => {
  it('Set-DhcpServerv4Failover modifie la relation des deux côtés', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '-LoadBalancePercent 50' });
    expect(await run(dhcp1, 'Set-DhcpServerv4Failover -Name F1 -LoadBalancePercent 70 -MaxClientLeadTime 02:00:00')).toBe('');
    for (const server of [dhcp1, dhcp2]) {
      const out = await run(server, 'Get-DhcpServerv4Failover -Name F1');
      expect(out).toMatch(/LoadBalancePercent\s+:\s+70/);
      expect(out).toMatch(/MaxClientLeadTime\s+:\s+02:00:00/);
    }
  }, 120000);

  it('Invoke-DhcpServerv4FailoverReplication pousse les changements de l étendue vers le partenaire', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '' });
    await run(dhcp1, 'Set-DhcpServerv4OptionValue -ScopeId Lan -OptionId 6 -Value 10.0.0.53');
    expect(await run(dhcp2, 'Get-DhcpServerv4OptionValue -ScopeId Lan')).not.toContain('10.0.0.53');
    expect(await run(dhcp1, 'Invoke-DhcpServerv4FailoverReplication -Name F1 -Force')).toBe('');
    expect(await run(dhcp2, 'Get-DhcpServerv4OptionValue -ScopeId Lan')).toContain('10.0.0.53');
  }, 120000);

  it('Add-DhcpServerv4FailoverScope apporte une seconde étendue au partenaire', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '' });
    await run(dhcp1, 'Add-DhcpServerv4Scope -Name Voice -StartRange 10.0.9.10 -EndRange 10.0.9.90 -SubnetMask 255.255.255.0');
    expect(await run(dhcp1, 'Add-DhcpServerv4FailoverScope -Name F1 -ScopeId Voice')).toBe('');
    expect(await run(dhcp2, 'Get-DhcpServerv4Scope')).toContain('Voice');
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover -Name F1')).toContain('10.0.9.0');
    expect(await run(dhcp1, 'Remove-DhcpServerv4FailoverScope -Name F1 -ScopeId Voice')).toBe('');
    expect(await run(dhcp1, 'Get-DhcpServerv4Failover -Name F1')).not.toContain('10.0.9.0');
  }, 120000);

  it('Remove-DhcpServerv4Failover retire la relation des deux côtés et garde les étendues', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '' });
    expect(await run(dhcp1, 'Remove-DhcpServerv4Failover -Name F1')).toBe('');
    expect(await run(dhcp1, 'Get-DhcpServerv4Failover')).toBe('');
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover')).toBe('');
    expect(await run(dhcp1, 'Get-DhcpServerv4Scope')).toContain('Lan');
    expect(await run(dhcp2, 'Get-DhcpServerv4Scope')).toContain('Lan');
  }, 120000);

  it('depuis le partenaire, la relation est administrable aussi (rôle secondaire)', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '' });
    expect(dhcp2.logonDomain('GOOGLE\\Administrator', DSRM).ok).toBe(true);
    expect(await run(dhcp2, 'Set-DhcpServerv4Failover -Name F1 -ReservePercent 20')).toBe('');
    expect(await run(dhcp1, 'Get-DhcpServerv4Failover -Name F1')).toMatch(/ReservePercent\s+:\s+20/);
  }, 120000);
});

describe('authentification des messages de partenaire', () => {
  const forged = (from: WindowsPC, secret: string | null, type: 'BNDUPD' | 'CONTACT' = 'BNDUPD') => sendFailoverMessage(from.getTcpStack(), DHCP2,
    signMessage({
      type, relationship: 'F1', from: 'DHCP1',
      body: { scope: 'Lan', ip: '10.0.0.150', released: false, binding: { ip: '10.0.0.150', clientId: 'aa:bb:cc:00:00:01', leaseStart: 0, leaseExpiration: 4102444800000, scope: 'Lan', type: 'automatic' } },
    }, secret));

  it('un message venant d une autre machine que le partenaire est refusé', async () => {
    const { dhcp2, snoop } = await lab({ failover: '-SharedSecret s3cret' });
    const reply = forged(snoop, 's3cret');
    expect(reply?.ok).toBe(false);
    expect(reply?.message).toMatch(/not the partner/);
    expect(await addressesOf(dhcp2)).toEqual([]);
  }, 120000);

  it('un message du partenaire dont la signature est fausse est refusé et n écrit rien', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '-SharedSecret s3cret' });
    const reply = forged(dhcp1 as unknown as WindowsPC, 'wrong');
    expect(reply?.ok).toBe(false);
    expect(reply?.message).toMatch(/authentication failed/);
    expect(await addressesOf(dhcp2)).toEqual([]);
  }, 120000);

  it('TEMOIN : le même message correctement signé par le partenaire est accepté', async () => {
    const { dhcp1, dhcp2 } = await lab({ failover: '-SharedSecret s3cret' });
    const reply = forged(dhcp1 as unknown as WindowsPC, 's3cret');
    expect(reply?.ok).toBe(true);
    expect(await addressesOf(dhcp2)).toEqual(['10.0.0.150']);
  }, 120000);

  it('un message d administration sans ticket Kerberos est refusé', async () => {
    const { dhcp2, snoop } = await lab();
    const reply = sendFailoverMessage(snoop.getTcpStack(), DHCP2, {
      type: 'SETUP', relationship: 'EVIL', from: 'SNOOP', body: { config: { name: 'EVIL' }, scopes: [] },
    });
    expect(reply?.ok).toBe(false);
    expect(reply?.message).toMatch(/Access is denied/);
    expect(await run(dhcp2, 'Get-DhcpServerv4Failover')).toBe('');
  }, 120000);
});
