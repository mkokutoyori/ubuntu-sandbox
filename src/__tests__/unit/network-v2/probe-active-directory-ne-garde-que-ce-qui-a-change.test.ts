/**
 * Un serveur promu controleur de domaine ne revenait PAS controleur de domaine apres une sauvegarde : tout l'annuaire
 * (unites d'organisation, comptes et mots de passe, groupes, GPO, sites, schema, ACL) etait perdu, et le serveur
 * rouvert repondait « Unable to find a default server with Active Directory Web Services running ».
 *
 * MESURE : `Install-ADDSForest lab.local`, une OU, un utilisateur, un groupe, un membre, un site, puis
 * sauvegarde/reouverture : seules les fonctionnalites installees revenaient (1 156 octets) ; `Get-ADUser`,
 * `Get-ADOrganizationalUnit`, `Get-ADGroupMember`, `Get-ADDomain`, `Get-ADReplicationSite` echouaient tous.
 *
 * Corrige en deux gestes, dans l'esprit « n'ecrire que ce qui a change » :
 *   - la PROMOTION est ecrite (les arguments d'Install-ADDSForest) et rejouee a l'importation, ce qui refait tout
 *     ce qu'une promotion provisionne (annuaire, SYSVOL, zone DNS, services, strategie d'audit) ;
 *   - l'ANNUAIRE est ecrit en delta contre un jumeau d'usine promu avec les memes arguments : les entrees dont les
 *     attributs (hors GUID, horodatages et secret de krbtgt) different, celles qui ont disparu, les ACL, le schema
 *     etendu, la cle KDS, les fonctionnalites optionnelles. Il est rejoue par `DirectoryStore.importSnapshot`, qui
 *     ecrit les entrees sans condition (la resolution de conflit de replication, elle, refuserait des entrees dont
 *     l'horodatage est plus ancien que celui de l'amorce).
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 7 cas sur 10 tombent. Les 3 qui
 * passent des deux cotes : le temoin « un serveur non promu n'ecrit aucune section annuaire » (temoin de laboratoire),
 * le fichier ajoute a SYSVOL (les fichiers etaient deja ecrits en delta, non-regression) et l'export qui laisse la
 * foret vivante intacte (structurel : avant, il n'y avait rien a isoler).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const PASSWORD = '(ConvertTo-SecureString "Passw0rd!123" -AsPlainText -Force)';

async function promotedController(name = 'DC1') {
  const server = new WindowsServer(name);
  server.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(server).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  await ps('Install-WindowsFeature AD-Domain-Services -IncludeManagementTools');
  await ps('Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd123!" -AsPlainText -Force) -Force');
  return { server, ps };
}

const exportOf = (devices: Equipment[]) => exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), []);

async function reopened(server: WindowsServer) {
  const json = JSON.parse(JSON.stringify(exportOf([server])));
  const back = await importTopology(json);
  const restored = [...back.deviceInstances.values()][0] as WindowsServer;
  restored.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(restored).subShell;
  return { json, restored, ps: async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n') };
}

describe('a freshly promoted controller writes its promotion and nothing of what promotion provisions', () => {
  it('witness: a server that was never promoted writes no directory section', () => {
    const plain = new WindowsServer('WS1');
    expect(exportOf([plain]).devices[0].activeDirectory).toBeUndefined();
  });

  it('only the promotion, and a reopened controller is still a controller with its default objects', async () => {
    const { server } = await promotedController();
    const [entry] = exportOf([server]).devices;
    expect(Object.keys(entry).filter((k) => !['id', 'type', 'name', 'x', 'y', 'isPoweredOn', 'interfaces'].includes(k)).sort())
      .toEqual(['activeDirectory', 'windowsFeatures']);
    expect(entry.activeDirectory?.delta).toBeUndefined();
    expect(entry.activeDirectory?.promotion.domainName).toBe('lab.local');
    expect(JSON.stringify(entry).length).toBeLessThan(2_500);

    const { ps } = await reopened(server);
    expect(await ps('Get-ADDomain | Select-Object -ExpandProperty DNSRoot')).toContain('lab.local');
    expect(await ps('Get-ADOrganizationalUnit -Filter * | Select-Object -ExpandProperty Name')).toContain('Domain Controllers');
    expect(await ps('Get-ADUser -Identity Administrator | Select-Object -ExpandProperty SamAccountName')).toContain('Administrator');
  });
});

describe('what was created in the directory is written, and comes back', () => {
  async function labDirectory() {
    const { server, ps } = await promotedController();
    await ps('New-ADOrganizationalUnit -Name Staff -Path "DC=lab,DC=local"');
    await ps(`New-ADUser -Name alice -SamAccountName alice -Path "OU=Staff,DC=lab,DC=local" -AccountPassword ${PASSWORD} -Enabled $true`);
    await ps('New-ADGroup -Name Admins2 -GroupScope Global -Path "OU=Staff,DC=lab,DC=local"');
    await ps('Add-ADGroupMember -Identity Admins2 -Members alice');
    await ps('New-ADReplicationSite -Name Douala');
    return server;
  }

  it('the delta holds the created objects and the ones they touched, not the seeded directory', async () => {
    const server = await labDirectory();
    const delta = exportOf([server]).devices[0].activeDirectory?.delta;
    const dns = (delta?.entries ?? []).map((e) => e.dn.toLowerCase());
    expect(dns).toContain('ou=staff,dc=lab,dc=local');
    expect(dns).toContain('cn=alice,ou=staff,dc=lab,dc=local');
    expect(dns).toContain('cn=admins2,ou=staff,dc=lab,dc=local');
    expect(dns).toContain('cn=douala,cn=sites,cn=configuration,dc=lab,dc=local');
    expect(dns.length).toBeLessThan(10);
    expect(dns).not.toContain('cn=users,dc=lab,dc=local');
  });

  it('after reopening the objects, the membership and the site are there', async () => {
    const server = await labDirectory();
    const { ps } = await reopened(server);
    expect(await ps('Get-ADUser -Identity alice | Select-Object -ExpandProperty DistinguishedName')).toContain('OU=Staff,DC=lab,DC=local');
    expect(await ps('Get-ADGroupMember -Identity Admins2 | Select-Object -ExpandProperty Name')).toContain('alice');
    expect(await ps('Get-ADReplicationSite -Filter * | Select-Object -ExpandProperty Name')).toContain('Douala');
  });

  it('a password survives, and so does a changed password of a seeded account', async () => {
    const { server, ps } = await promotedController();
    await ps(`New-ADUser -Name bob -SamAccountName bob -AccountPassword ${PASSWORD} -Enabled $true`);
    await ps('Set-ADAccountPassword -Identity Administrator -Reset -NewPassword (ConvertTo-SecureString "N3wAdmin!456" -AsPlainText -Force)');
    const { restored } = await reopened(server);
    const store = restored.getDirectoryStore()!;
    expect(store.checkPassword('bob', 'Passw0rd!123')).toBe(true);
    expect(store.checkPassword('Administrator', 'N3wAdmin!456')).toBe(true);
  });

  it('the identifiers keep going where they stopped: a new user after reopening does not reuse a RID', async () => {
    const { server, ps } = await promotedController();
    await ps(`New-ADUser -Name bob -SamAccountName bob -AccountPassword ${PASSWORD} -Enabled $true`);
    const { restored, ps: after } = await reopened(server);
    await after(`New-ADUser -Name carol -SamAccountName carol -AccountPassword ${PASSWORD} -Enabled $true`);
    const store = restored.getDirectoryStore()!;
    expect(store.getUser('carol')?.sid).not.toBe(store.getUser('bob')?.sid);
  });

  it('a removed object stays removed, and a removed OU takes nothing else with it', async () => {
    const { server, ps } = await promotedController();
    await ps('New-ADOrganizationalUnit -Name Temp -Path "DC=lab,DC=local" -ProtectedFromAccidentalDeletion $false');
    await ps('Remove-ADOrganizationalUnit -Identity "OU=Temp,DC=lab,DC=local" -Confirm:$false');
    const { restored } = await reopened(server);
    expect(restored.getDirectoryStore()!.listOrgUnits().map((o) => o.name)).not.toContain('Temp');
  });

  it('a GPO, its registry setting and its link, the optional features, the schema and an ACL come back', async () => {
    const { server } = await promotedController();
    const store = server.getDirectoryStore()!;
    store.newGpo('LabPolicy', 'lab');
    store.setGpRegistryValue('LabPolicy', { key: 'HKLM\\Software\\Lab', valueName: 'Enabled', type: 'DWord', value: '1' });
    store.newGPLink('LabPolicy', 'DC=lab,DC=local');
    store.enableOptionalFeature('Recycle Bin Feature', 'CN=Directory Service,CN=Windows NT,CN=Services,CN=Configuration,DC=lab,DC=local');
    store.newAttribute({ ldapDisplayName: 'labBadge', attributeSyntax: '2.5.5.12', isSingleValued: true });
    store.newOrgUnit('Staff');
    store.setAcl('OU=Staff,DC=lab,DC=local', [{
      identitySam: 'Administrator', rights: 'GenericAll', accessControlType: 'Allow',
      objectType: '', inheritanceType: 'None', inheritedObjectType: '',
    }]);

    const { restored } = await reopened(server);
    const back = restored.getDirectoryStore()!;
    expect(back.getGpo('LabPolicy')?.description).toBe('lab');
    expect(back.getGpRegistryValues('LabPolicy', 'HKLM\\Software\\Lab', 'Enabled')?.length).toBe(1);
    expect(back.getGpInheritance('DC=lab,DC=local')?.gpoLinks.map((l) => l.displayName)).toContain('LabPolicy');
    expect(back.isOptionalFeatureEnabled('Recycle Bin Feature')).toBe(true);
    expect(back.listSchemaAttributes().some((a) => a.ldapDisplayName === 'labBadge')).toBe(true);
    expect(back.getAcl('OU=Staff,DC=lab,DC=local')?.some((r) => r.identitySam === 'Administrator' && r.rights === 'GenericAll')).toBe(true);
  });

  it('a file added to SYSVOL is written once, the SYSVOL the promotion lays down is not', async () => {
    const { server } = await promotedController();
    server.getFileSystem().createFile('C:\\Windows\\SYSVOL\\sysvol\\lab.local\\SCRIPTS\\logon.cmd', '@echo hi');
    const [entry] = exportOf([server]).devices;
    expect((entry.files as { path: string }[]).map((f) => f.path)).toEqual(['C:\\Windows\\SYSVOL\\sysvol\\lab.local\\SCRIPTS\\logon.cmd']);
    const { restored } = await reopened(server);
    expect(restored.getFileSystem().readFile('C:\\Windows\\SYSVOL\\sysvol\\lab.local\\SCRIPTS\\logon.cmd').content).toBe('@echo hi');
  });

  it('exporting leaves the live forest alone: the controller still finds its own forest', async () => {
    const { server } = await promotedController();
    exportOf([server]);
    const { getForestForDomain } = await import('@/network/devices/windows/server/ad/forest/Forest');
    expect(getForestForDomain('lab.local')?.listDomains().length).toBe(1);
    expect(server.getDirectoryStore()).not.toBeNull();
    expect(new WindowsPC('windows-pc', 'W').getDirectoryStore()).toBeNull();
  });
});
