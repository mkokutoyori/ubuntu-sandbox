/**
 * Un poste joint au domaine (Add-Computer / netdom join) ne l'etait plus apres une sauvegarde : l'appartenance au
 * domaine, les objets de strategie de groupe deja appliques (gpresult), la banniere legale, le script de demarrage
 * et les comptes de service installes n'etaient dans aucune section ; le compte d'ordinateur restait dans l'annuaire
 * du controleur, le poste ne le savait plus.
 *
 * MESURE : DCA (a.local), DCB (b.local) approuves entre eux (New-ADTrust Bidirectional) et PC1 joint a a.local,
 * gpupdate /force, puis sauvegarde et reouverture :
 *   - (Win32_ComputerSystem).PartOfDomain rendait False, Test-ComputerSecureChannel refusait « not currently joined »,
 *     gpresult /r refusait « not a member of a domain » (le poste n'ecrivait que sa section fichiers) ;
 *   - les approbations, elles, SURVIVAIENT deja : une approbation est une entree trustedDomain de chaque annuaire,
 *     donc le delta d'annuaire l'ecrit des deux cotes. L'entree TODO qui les declarait « non sauvegardees » etait
 *     fausse, elle a ete corrigee ; ces cas sont des temoins de non-regression, pas des corrections ;
 *   - la politique locale de comptes (`net accounts`) et la politique d'audit (`auditpol`) n'etaient sauvegardees
 *     nulle part, alors que la strategie de groupe ecrit precisement dans ces deux magasins : une
 *     minPasswordLength imposee par GPO disparaissait.
 *
 * Corrige : WindowsPC.captureDomainState/restoreDomainState (appartenance, comptes de service, etat client de la
 * strategie de groupe) ; WindowsAccountsPolicy.restore et WindowsAuditPolicy.exportState/importState, ecrits en delta
 * contre le jumeau d'usine (src/store/windowsSecurityPolicy.ts). La restauration ne dialogue PAS avec le controleur :
 * l'etat est rejoue tel quel, et c'est un vrai bind LDAP sur les cables restaures qui prouve l'accord des deux cotes
 * du secret d'ordinateur.
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 11 cas sur 18 tombent. Les 7 qui
 * passent des deux cotes : les 4 cas d'approbation (non-regression, voir plus haut) et trois temoins « il n'y a rien
 * a ecrire » (poste hors domaine, machine intacte, controleur dont la base d'audit vient de la promotion).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { resetForestRegistry } from '@/network/devices/windows/server/ad/forest/Forest';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { crossRealmTgsExchange } from '@/network/kerberos/crossRealm';
import type { Equipment } from '@/network';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetForestRegistry();
});

const SAFE = '(ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

const shellOf = (device: WindowsServer | WindowsPC) => {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab(options: { join?: boolean; trust?: 'Bidirectional' | 'Outbound' | false } = {}) {
  const { join = true, trust = 'Bidirectional' } = options;
  const dcA = new WindowsServer('DCA');
  const dcB = new WindowsServer('DCB');
  const pc = new WindowsPC('windows-pc', 'PC1');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  const devices = [dcA, dcB, pc];
  const connections = devices.map((d, i) => buildConnection(d, d.getPorts()[0].getName(), hub, hub.getPorts()[i].getName(), 'ethernet')!);
  const mask = new SubnetMask('255.255.255.0');
  devices.forEach((d, i) => {
    d.getPorts()[0].configureIP(new IPAddress(`192.168.95.${10 + i}`), mask);
    d.setCurrentUser('Administrator');
  });
  const ps = { a: shellOf(dcA), b: shellOf(dcB), pc: shellOf(pc) };
  await ps.a('Install-WindowsFeature AD-Domain-Services');
  await ps.a(`Install-ADDSForest -DomainName a.local -SafeModeAdministratorPassword ${SAFE}`);
  await ps.b('Install-WindowsFeature AD-Domain-Services');
  await ps.b(`Install-ADDSForest -DomainName b.local -SafeModeAdministratorPassword ${SAFE}`);
  await ps.a('New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  if (trust) {
    await ps.a(`New-ADTrust -Target b.local -Direction ${trust} -Credential "Administrator:P@ssw0rd" -Server 192.168.95.11`);
  }
  if (join) {
    await ps.pc(`Add-Content -Path "${HOSTS}" -Value "192.168.95.10 a.local\`n192.168.95.10 DCA.a.local"`);
    await ps.pc('Add-Computer -DomainName "a.local" -Credential "Administrator:P@ssw0rd"');
  }
  return { dcA, dcB, pc, hub, all: [...devices, hub] as Equipment[], connections, ps };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2]) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>) {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d]));
  for (const device of byName.values()) if (device instanceof WindowsPC) device.setCurrentUser('Administrator');
  const dcA = byName.get('DCA') as WindowsServer;
  const dcB = byName.get('DCB') as WindowsServer;
  const pc = byName.get('PC1') as WindowsPC;
  return { dcA, dcB, pc, ps: { a: shellOf(dcA), b: shellOf(dcB), pc: shellOf(pc) } };
}

describe('trusts already travel, because a trust is an entry of each directory (non-regression)', () => {
  it('both sides are there after reopening, with the same direction and the same interrealm key', async () => {
    const lab = await buildLab({ join: false });
    const { dcA, dcB, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps.a('Get-ADTrust -Identity b.local')).toContain('Bidirectional');
    expect(await ps.b('Get-ADTrust -Identity a.local')).toContain('Bidirectional');
    expect(dcA.getTrust('b.local')?.interrealmKey).toBe(dcB.getTrust('a.local')?.interrealmKey);
    expect(dcA.getTrust('b.local')?.interrealmKey).toBe(lab.dcA.getTrust('b.local')?.interrealmKey);
  });

  it('a cross-realm referral is still granted over the wire by the reopened controllers', async () => {
    const lab = await buildLab({ join: false });
    const { dcA, dcB, pc } = await reopen(exportOf(lab.all, lab.connections));
    const kdc = dialKdc(pc.getTcpStack(), '192.168.95.10');
    expect(kdc.ok).toBe(true);
    const as = kdc.client!.asExchange('alice', 'alicepw', 'A.LOCAL');
    expect(as.ok).toBe(true);
    const referral = crossRealmTgsExchange(
      pc.getTcpStack(), '192.168.95.10', '192.168.95.11', as.ticket!, as.sessionKey!,
      { nameType: 1, nameString: ['alice'] }, 'A.LOCAL', 'B.LOCAL', dcB.getHostname(),
    );
    expect(referral.ok).toBe(true);
    expect(referral.ticket?.realm).toBe('B.LOCAL');
    expect(dcA.getTrust('b.local')).not.toBeNull();
  });

  it('a one-way trust keeps its direction on each side', async () => {
    const lab = await buildLab({ join: false, trust: 'Outbound' });
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps.a('Get-ADTrust -Identity b.local')).toContain('Outbound');
    expect(await ps.b('Get-ADTrust -Identity a.local')).toContain('Inbound');
  });

  it('a removed trust stays removed', async () => {
    const lab = await buildLab({ join: false });
    lab.dcA.getDirectoryStore()!.removeTrust('b.local');
    const { dcA, dcB } = await reopen(exportOf(lab.all, lab.connections));
    expect(dcA.getTrust('b.local')).toBeNull();
    expect(dcB.getTrust('a.local')).not.toBeNull();
  });
});

describe('a machine joined to the domain is still joined after reopening', () => {
  it('witness: a workgroup machine writes no domain section and no security section', async () => {
    const lab = await buildLab({ join: false });
    const [, , pcEntry] = exportOf(lab.all, lab.connections).devices;
    expect(pcEntry.windowsDomain).toBeUndefined();
    expect(pcEntry.windowsSecurity).toBeUndefined();
  });

  it('it knows its domain again, and its computer account still opens a real secure channel', async () => {
    const lab = await buildLab();
    const { pc, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(pc.getDomainMembership()).toEqual(lab.pc.getDomainMembership());
    expect(await ps.pc('(Get-WmiObject Win32_ComputerSystem).PartOfDomain')).toContain('True');
    expect(await ps.pc('Test-ComputerSecureChannel')).toContain('True');
  });

  it('a domain user can still log on to it, against the reopened controller', async () => {
    const lab = await buildLab();
    const { pc } = await reopen(exportOf(lab.all, lab.connections));
    expect(pc.logonDomain('A\\alice', 'alicepw')).toEqual({ ok: true, message: '' });
    expect(pc.logonDomain('A\\alice', 'wrong').ok).toBe(false);
  });

  it('a rotated machine secret is the one that comes back, on both sides', async () => {
    const lab = await buildLab();
    expect(lab.pc.resetSecureChannel('Administrator', 'P@ssw0rd').ok).toBe(true);
    const { pc, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(pc.getDomainMembership()?.machineSecret).toBe(lab.pc.getDomainMembership()?.machineSecret);
    expect(await ps.pc('Test-ComputerSecureChannel')).toContain('True');
  });

  it('it writes the membership and nothing else about the join: the account lives in the directory', async () => {
    const lab = await buildLab();
    const [dcEntry, , pcEntry] = exportOf(lab.all, lab.connections).devices;
    expect(Object.keys(pcEntry.windowsDomain ?? {})).toEqual(['membership']);
    expect((dcEntry.activeDirectory?.delta?.entries ?? []).map((e) => e.dn.toLowerCase())).toContain('cn=pc1,cn=computers,dc=a,dc=local');
  });

  it('an installed managed service account is still installed', async () => {
    const lab = await buildLab();
    lab.pc.markServiceAccountInstalled('svc-web');
    const { pc } = await reopen(exportOf(lab.all, lab.connections));
    expect(pc.hasServiceAccountInstalled('svc-web')).toBe(true);
  });
});

describe('what group policy already applied is still applied after reopening', () => {
  async function labWithAppliedPolicy() {
    const lab = await buildLab();
    lab.dcA.getDirectoryStore()!.setGpoSettings('Default Domain Policy', {
      logonBanner: { title: 'Authorized use only', text: 'Everything is logged.' },
      startupScript: '\\\\a.local\\NETLOGON\\start.cmd',
    });
    await lab.pc.executeCmdCommand('gpupdate /force');
    return lab;
  }

  it('gpresult still lists the objects, the legal notice and the startup script', async () => {
    const lab = await labWithAppliedPolicy();
    const before = await lab.pc.executeCmdCommand('gpresult /r');
    expect(before).toContain('Default Domain Policy');
    const { pc } = await reopen(exportOf(lab.all, lab.connections));
    const after = await pc.executeCmdCommand('gpresult /r');
    expect(after).toContain('Default Domain Policy');
    expect(after).toContain('Caption: Authorized use only');
    expect(after).toContain('\\\\a.local\\NETLOGON\\start.cmd');
    expect(after).toContain(`Last time Group Policy was applied: ${lab.pc.captureDomainState()!.groupPolicy!.lastAppliedAt ? new Date(lab.pc.captureDomainState()!.groupPolicy!.lastAppliedAt!).toString() : ''}`);
  });

  it('the account policy a GPO imposed is the one `net accounts` reports', async () => {
    const lab = await labWithAppliedPolicy();
    expect(await lab.pc.executeCmdCommand('net accounts')).toContain('Minimum password length:                              7');
    const { pc } = await reopen(exportOf(lab.all, lab.connections));
    expect(await pc.executeCmdCommand('net accounts')).toContain('Minimum password length:                              7');
  });

  it('a controller that applied its own policy keeps it too', async () => {
    const lab = await labWithAppliedPolicy();
    await lab.dcA.executeCmdCommand('gpupdate /force');
    const { dcA } = await reopen(exportOf(lab.all, lab.connections));
    expect(await dcA.executeCmdCommand('gpresult /r')).toContain('Default Domain Policy');
  });

  it('it writes the policy it applied, not the machine it was applied to', async () => {
    const lab = await labWithAppliedPolicy();
    const [, , pcEntry] = exportOf(lab.all, lab.connections).devices;
    expect(Object.keys(pcEntry.windowsDomain ?? {}).sort()).toEqual(['groupPolicy', 'membership']);
    expect(pcEntry.windowsSecurity?.accounts).toMatchObject({ minPasswordLength: 7 });
    expect(JSON.stringify(pcEntry).length).toBeLessThan(3_500);
  });
});

describe('the local security policy was saved nowhere', () => {
  it('`net accounts` set by hand survives', async () => {
    const pc = new WindowsPC('windows-pc', 'PC9');
    pc.setCurrentUser('Administrator');
    await pc.executeCmdCommand('net accounts /minpwlen:11 /lockoutthreshold:4');
    const json = exportOf([pc], []);
    expect(json.devices[0].windowsSecurity?.accounts).toEqual({ minPasswordLength: 11, lockoutThreshold: 4 });
    const back = await importTopology(JSON.parse(JSON.stringify(json)));
    const restored = [...back.deviceInstances.values()][0] as WindowsPC;
    restored.setCurrentUser('Administrator');
    const report = await restored.executeCmdCommand('net accounts');
    expect(report).toContain('Minimum password length:                              11');
    expect(report).toContain('Lockout threshold:                                    4');
  });

  it('the audit policy survives: subcategories, options, per-user entries, resource SACL and descriptor', async () => {
    const pc = new WindowsPC('windows-pc', 'PC9');
    pc.auditPolicy.set('File Share', { success: true, failure: true });
    pc.auditPolicy.set('Logon', { failure: false });
    pc.auditPolicy.setOption('CrashOnAuditFail', true);
    pc.auditPolicy.setPerUser('bob', 'Logon', 'exclude', { success: true });
    pc.auditPolicy.setResourceSacl('File', { success: true });
    pc.auditPolicy.setResourceSacl('File', { failure: true, account: 'Bob' });
    pc.auditPolicy.setSecurityDescriptor('O:BAG:SYD:(A;;RCWDWO;;;BA)');
    const json = exportOf([pc], []);
    expect(json.devices[0].windowsSecurity?.audit?.subcategories?.map((s) => s.name).sort()).toEqual(['File Share', 'Logon']);
    const back = await importTopology(JSON.parse(JSON.stringify(json)));
    const restored = [...back.deviceInstances.values()][0] as WindowsPC;
    expect(restored.auditPolicy.exportState()).toEqual(pc.auditPolicy.exportState());
  });

  it('an untouched machine writes none of it', async () => {
    const pc = new WindowsPC('windows-pc', 'PC9');
    expect(exportOf([pc], []).devices[0].windowsSecurity).toBeUndefined();
  });

  it('a controller does not write the audit baseline its promotion laid down', async () => {
    const lab = await buildLab({ join: false, trust: false });
    const [dcEntry] = exportOf(lab.all, lab.connections).devices;
    expect(dcEntry.windowsSecurity).toBeUndefined();
  });
});
