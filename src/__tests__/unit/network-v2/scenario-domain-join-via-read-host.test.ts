/*
 * Probe — le poste rejoint le domaine que la forêt, promue avec un mot de
 * passe DSRM saisi par `(Read-Host -AsSecureString …)`, publie dans son DNS.
 *
 * Chaîne réelle, de bout en bout, sans jamais nommer le DC au poste :
 *   1. Le DC promeut google.com, le mot de passe DSRM venant d'une
 *      `(Read-Host -AsSecureString "…")` imbriquée — la correction qui rend
 *      cette forme interactive au lieu de « read-host is not recognized ».
 *   2. `-InstallDns` pose la zone et l'enregistrement SRV
 *      `_ldap._tcp.dc._msdcs.google.com` du localisateur de DC.
 *   3. Le poste pointe son client DNS sur le DC, puis `Add-Computer
 *      -DomainName google.com` SANS `-Server` : le localisateur lit le SRV,
 *      résout la cible, et la jonction crée le compte machine sur le fil.
 *   4. Une ouverture de session de domaine réussit sur le poste joint.
 *
 * Autorité : PowerShell `Read-Host -AsSecureString`, `Install-ADDSForest`,
 * `Add-Computer -DomainName` (about_*), et la localisation de DC par SRV
 * `_ldap._tcp.dc._msdcs.<domaine>` (RFC 2782) que la promotion publie.
 *
 * Mesuré avant le correctif (versions pré-Read-Host de src/terminal +
 * src/powershell, `git checkout 80b566f22~1 --`) : 3 des 4 cas tombent —
 * ceux qui promeuvent la forêt via la `(Read-Host …)` imbriquée. Passe des
 * deux côtés, et pourquoi :
 *  - « TÉMOIN : le même lab, DSRM fourni directement, joint le domaine » —
 *    la forêt promue sans Read-Host (ConvertTo-SecureString) publie son
 *    SRV et le poste rejoint : réseau, DNS, localisateur et jonction sont
 *    sains, donc un échec des autres cas accuse la résolution imbriquée et
 *    non un lab cassé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { InputHost, InputCompletion } from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const M24 = new SubnetMask('255.255.255.0');

function makeHost(answer: string) {
  let pending: ((o: InputCompletion) => void) | null = null;
  const host: InputHost = {
    requestInput(_req: InputRequest, complete) { pending = complete; setTimeout(() => { const cb = pending; pending = null; cb?.({ status: 'submitted', value: answer }); }, 0); },
    cancelRequest() { pending = null; },
    emit() {},
    attachStream() { return { id: 'x', description: '', active: true, cancel() {} }; },
    detachAllStreams() {},
    capabilities() { return { interactive: true, maskedSupported: true, streaming: true }; },
  };
  return host;
}

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsServer | WindowsPC, l: string) => (await ps(d).processLine(l)).output.join('\n');

async function runInteractive(d: WindowsServer | WindowsPC, l: string, answer: string): Promise<string> {
  const sh = PowerShellSubShell.create(d).subShell;
  sh.setInputHost(makeHost(answer));
  return (await sh.processLine(l)).output.join('\n');
}

interface Lab { dc: WindowsServer; client: WindowsPC }

async function lab(readHostDsrm: boolean): Promise<Lab> {
  const dc = new WindowsServer('DC01');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  for (const d of [dc, client, sw]) d.powerOn();
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-cli').connect(client.getPorts()[0], sw.getPorts()[1]);
  dc.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), M24);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.30'), M24);
  dc.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(dc, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  const head = 'Install-ADDSForest -DomainName "google.com" -DomainNetbiosName "GOOGLE" '
    + '-DomainMode "WinThreshold" -ForestMode "WinThreshold" -InstallDns:$true ';
  if (readHostDsrm) {
    await runInteractive(dc,
      head + '-SafeModeAdministratorPassword (Read-Host -AsSecureString "Entrez le mot de passe DSRM") -Force',
      'DSRM@Google2025!');
  } else {
    await run(dc, head + '-SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Google2025!" -AsPlainText -Force) -Force');
  }
  await run(dc, 'New-ADUser -Name jdupont -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
  return { dc, client };
}

async function joinClient(l: Lab): Promise<string> {
  await run(l.client, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.0.0.10');
  return run(l.client, 'Add-Computer -DomainName "google.com" -Credential "Administrator:DSRM@Google2025!"');
}

describe("Jonction de domaine via une Read-Host imbriquée pour le mot de passe DSRM", () => {
  it('TÉMOIN : le même lab, DSRM fourni directement, joint le domaine', async () => {
    const l = await lab(false);
    const out = await joinClient(l);
    expect(out).not.toMatch(/could not be contacted|not recognized/i);
    expect(l.client.getDomainMembership()?.dnsName).toBe('google.com');
    expect(l.dc.getDirectoryStore()!.getComputer('CLIENT1')).not.toBeNull();
  }, 60_000);

  it('la forêt promue via (Read-Host) publie son SRV de localisateur', async () => {
    const { dc } = await lab(true);
    expect(dc.getDirectoryStore()).not.toBeNull();
    const srv = await dc.executeCommand('nslookup -type=SRV _ldap._tcp.dc._msdcs.google.com 10.0.0.10');
    expect(srv).toContain('DC01.google.com');
    expect(srv).toContain('389');
  }, 60_000);

  it('le poste rejoint google.com sans qu on lui nomme le DC', async () => {
    const l = await lab(true);
    const out = await joinClient(l);
    expect(out).not.toMatch(/could not be contacted|not recognized/i);
    expect(l.client.getDomainMembership()?.dnsName).toBe('google.com');
    expect(l.dc.getDirectoryStore()!.getComputer('CLIENT1')).not.toBeNull();
  }, 60_000);

  it('une ouverture de session de domaine réussit sur le poste joint', async () => {
    const l = await lab(true);
    await joinClient(l);
    const res = l.client.logonDomain('GOOGLE\\jdupont', 'Passw0rd!');
    expect(res.ok).toBe(true);
    expect(l.client.getDomainSession()?.sam).toBe('jdupont');
  }, 60_000);
});
