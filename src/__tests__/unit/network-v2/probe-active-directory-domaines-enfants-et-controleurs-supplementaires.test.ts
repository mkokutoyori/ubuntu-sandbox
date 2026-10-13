/**
 * Un controleur de domaine ENFANT (New-ADDomain) ou SUPPLEMENTAIRE (Install-ADDSDomainController) ne revenait pas
 * controleur de domaine apres une sauvegarde : la sauvegarde ne connaissait que la promotion d'une racine de foret,
 * si bien que ces deux serveurs rouverts n'avaient plus d'annuaire du tout (Get-ADDomain impossible, services NTDS
 * et zone DNS absents).
 *
 * MESURE : DC1 (foret lab.local), DC2 (Install-ADDSDomainController), DC3 (New-ADDomain child.lab.local) sur un
 * commutateur, une OU par domaine, sauvegarde puis reouverture : DC2 et DC3 revenaient sans annuaire (4 octets de
 * section chacun) ; DC1 ecrivait en plus sa propre entree d'ordinateur parce que son jumeau d'usine n'avait pas
 * d'adresse IP, donc pas le meme attribut ipAddress.
 *
 * Corrige ainsi :
 *   - la promotion porte un genre (foret, domaine enfant, controleur supplementaire) et se rejoue en LOCAL : les
 *     verifications faites sur le fil (liaison LDAP, synchronisation initiale) ont eu lieu a l'origine, pas a
 *     l'ouverture du fichier ;
 *   - un domaine enfant s'ecrit contre un jumeau promu dans une foret de substitution (la foret vivante n'est pas
 *     touchee) ; son schema est celui de la foret, ecrit une seule fois par la racine ;
 *   - un controleur supplementaire s'ecrit contre l'annuaire VIVANT du controleur principal de son domaine : ce
 *     qu'il a replique n'est pas ecrit deux fois, ce qu'il n'a pas replique (une entree propre, une entree
 *     supprimee, une absente) l'est. A l'ouverture le principal est restaure d'abord (tri par dependance) ;
 *   - les proprietaires FSMO de foret (maitre de schema, maitre de denomination) vivent sur l'objet Forest, pas
 *     dans un annuaire : ils sont ecrits quand ils ont quitte le fondateur ;
 *   - le jumeau recoit les adresses IP du vrai serveur le temps de sa promotion, pour ne plus ecrire l'entree
 *     d'ordinateur du controleur ni les enregistrements DNS qui en derivent.
 * Un replica herite maintenant du validateur de schema de la foret (il en avait un vide, donc plus permissif).
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 12 cas sur 14 tombent. Les 2 qui
 * passent des deux cotes : le temoin « la racine revient controleur quel que soit l'ordre du fichier » (temoin de
 * laboratoire : la racine etait deja sauvegardee) et « l'export laisse la foret vivante intacte » (structurel : avant,
 * il n'y avait rien a isoler).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { resetForestRegistry } from '@/network/devices/windows/server/ad/forest/Forest';
import { pullReplication } from '@/network/devices/windows/server/ad/replication/ReplicationSession';
import type { Equipment } from '@/network';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetForestRegistry();
});

const SAFE = '(ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const USER_PASSWORD = '(ConvertTo-SecureString "Passw0rd!123" -AsPlainText -Force)';

const shellOf = (server: WindowsServer) => {
  const sub = PowerShellSubShell.create(server).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab() {
  const root = new WindowsServer('DC1');
  const replica = new WindowsServer('DC2');
  const child = new WindowsServer('DC3');
  const servers = [root, replica, child];
  const hub = new GenericSwitch('switch-generic', 'SW1');
  const connections = servers.map((s, i) => buildConnection(s, s.getPorts()[0].getName(), hub, hub.getPorts()[i].getName(), 'ethernet')!);
  const mask = new SubnetMask('255.255.255.0');
  servers.forEach((s, i) => {
    s.getPorts()[0].configureIP(new IPAddress(`192.168.90.${10 + i}`), mask);
    s.setCurrentUser('Administrator');
  });
  const ps = { root: shellOf(root), replica: shellOf(replica), child: shellOf(child) };
  await ps.root('Install-WindowsFeature AD-Domain-Services');
  await ps.root(`Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword ${SAFE}`);
  await ps.replica('Install-WindowsFeature AD-Domain-Services');
  await ps.replica(`Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.90.10 -SafeModeAdministratorPassword ${SAFE}`);
  await ps.child('Install-WindowsFeature AD-Domain-Services');
  await ps.child(`New-ADDomain -NewDomainName child.lab.local -ParentDomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.90.10 -SafeModeAdministratorPassword ${SAFE}`);
  return { root, replica, child, servers, all: [...servers, hub], connections, hub, ps };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2] = []) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>) {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d as WindowsServer]));
  for (const server of byName.values()) if (server instanceof WindowsServer) server.setCurrentUser('Administrator');
  return { back, byName, ps: (name: string) => shellOf(byName.get(name)!) };
}

describe('a child domain controller is still a controller of its domain after reopening', () => {
  async function labWithChildData() {
    const lab = await buildLab();
    await lab.ps.child('New-ADOrganizationalUnit -Name Kids -Path "DC=child,DC=lab,DC=local"');
    await lab.ps.child(`New-ADUser -Name tom -SamAccountName tom -Path "OU=Kids,DC=child,DC=lab,DC=local" -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    return lab;
  }

  it('witness: the forest root still comes back as a controller, whatever the order of the file', async () => {
    const lab = await buildLab();
    const json = exportOf(lab.all, lab.connections);
    json.devices.reverse();
    const { byName } = await reopen(json);
    expect(byName.get('DC1')!.getDirectoryStore()?.dnsName).toBe('lab.local');
  });

  it('it reopens with its own directory, its objects and its place in the forest', async () => {
    const lab = await labWithChildData();
    const { byName, ps } = await reopen(exportOf(lab.all, lab.connections));
    const child = byName.get('DC3')!;
    expect(child.getDirectoryStore()?.dnsName).toBe('child.lab.local');
    expect(await ps('DC3')('Get-ADOrganizationalUnit -Filter * | Select-Object -ExpandProperty Name')).toContain('Kids');
    expect(await ps('DC3')('Get-ADUser -Identity tom | Select-Object -ExpandProperty DistinguishedName')).toContain('OU=Kids,DC=child,DC=lab,DC=local');
    expect(child.getDirectoryStore()!.checkPassword('tom', 'Passw0rd!123')).toBe(true);
    expect(child.getForest()?.listDomains().map((d) => d.dnsName).sort()).toEqual(['child.lab.local', 'lab.local']);
  });

  it('the promotion replays what a promotion provisions: services, DNS zone, SYSVOL', async () => {
    const lab = await labWithChildData();
    const { byName } = await reopen(exportOf(lab.all, lab.connections));
    const child = byName.get('DC3')!;
    expect(child.getServiceManager().getService('NTDS')).toBeTruthy();
    expect(child.getDnsServerRole()?.getZone('child.lab.local')).toBeTruthy();
    expect(child.getFileSystem().exists('C:\\Windows\\SYSVOL\\sysvol\\child.lab.local')).toBe(true);
  });

  it('it writes its own objects, not the directory its promotion seeds, and no schema', async () => {
    const lab = await labWithChildData();
    const [, , childEntry] = exportOf(lab.all, lab.connections).devices;
    const dns = (childEntry.activeDirectory?.delta?.entries ?? []).map((e) => e.dn.toLowerCase());
    expect(dns).toContain('ou=kids,dc=child,dc=lab,dc=local');
    expect(dns).toContain('cn=tom,ou=kids,dc=child,dc=lab,dc=local');
    expect(dns.length).toBeLessThan(6);
    expect(childEntry.activeDirectory?.delta?.schema).toEqual({ attributes: [], classes: [] });
  });

  it('an attribute added to the forest schema is written once, by the root, and enforced in the child', async () => {
    const lab = await buildLab();
    lab.root.getDirectoryStore()!.newAttribute({ ldapDisplayName: 'labBadge', attributeSyntax: '2.5.5.12', isSingleValued: true });
    const json = exportOf(lab.all, lab.connections);
    expect(json.devices[0].activeDirectory?.delta?.schema.attributes.map((a) => a.ldapDisplayName)).toEqual(['labBadge']);
    expect(json.devices[2].activeDirectory?.delta?.schema.attributes ?? []).toEqual([]);
    const { byName } = await reopen(json);
    expect(byName.get('DC3')!.getDirectoryStore()!.listSchemaAttributes().some((a) => a.ldapDisplayName === 'labBadge')).toBe(true);
  });

  it('exporting leaves the live forest and its three domains intact', async () => {
    const lab = await buildLab();
    exportOf(lab.all, lab.connections);
    expect(lab.root.getForest()?.listDomains().length).toBe(2);
    expect(lab.child.getForest()).toBe(lab.root.getForest());
  });
});

describe('an additional controller is a replica that remembers what it has not replicated', () => {
  async function labWithDivergence() {
    const lab = await buildLab();
    await lab.ps.root(`New-ADUser -Name alice -SamAccountName alice -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    pullReplication(lab.replica.getTcpStack(), '192.168.90.10', lab.replica.getDirectoryStore()!);
    await lab.ps.replica(`New-ADUser -Name bob -SamAccountName bob -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    await lab.ps.root('New-ADOrganizationalUnit -Name Late -Path "DC=lab,DC=local"');
    return lab;
  }

  it('it reopens as a controller of the same domain, with what it had replicated and what it had written', async () => {
    const lab = await labWithDivergence();
    const { byName } = await reopen(exportOf(lab.all, lab.connections));
    const replica = byName.get('DC2')!.getDirectoryStore()!;
    expect(replica.dnsName).toBe('lab.local');
    expect(replica.getUser('alice')).not.toBeNull();
    expect(replica.getUser('bob')).not.toBeNull();
    expect(byName.get('DC1')!.getDirectoryStore()!.getUser('bob')).toBeNull();
  });

  it('it does not invent what it had not replicated: an object only the primary holds stays absent until a pull', async () => {
    const lab = await labWithDivergence();
    const { byName } = await reopen(exportOf(lab.all, lab.connections));
    const replica = byName.get('DC2')!;
    expect(replica.getDirectoryStore()!.getOrgUnit('Late')).toBeNull();
    expect(byName.get('DC1')!.getDirectoryStore()!.getOrgUnit('Late')).not.toBeNull();
    const pull = pullReplication(replica.getTcpStack(), '192.168.90.10', replica.getDirectoryStore()!);
    expect(pull.ok).toBe(true);
    expect(replica.getDirectoryStore()!.getOrgUnit('Late')).not.toBeNull();
  });

  it('it is written against its primary: the replicated domain is not written twice', async () => {
    const lab = await labWithDivergence();
    const json = exportOf(lab.all, lab.connections);
    const entry = json.devices[1].activeDirectory!;
    expect(entry.baselineDeviceId).toBe(lab.root.getId());
    const dns = (entry.delta?.entries ?? []).map((e) => e.dn.toLowerCase());
    expect(dns).toContain('cn=bob,cn=users,dc=lab,dc=local');
    expect(dns).not.toContain('cn=alice,cn=users,dc=lab,dc=local');
    expect(entry.delta?.removedDns.map((d) => d.toLowerCase())).toContain('ou=late,dc=lab,dc=local');
    expect(JSON.stringify(entry).length).toBeLessThan(JSON.stringify(json.devices[0].activeDirectory).length);
  });

  it('whatever the order of the file, the primary is restored before the replica', async () => {
    const lab = await labWithDivergence();
    const json = exportOf(lab.all, lab.connections);
    json.devices.reverse();
    const { byName } = await reopen(json);
    expect(byName.get('DC2')!.getDirectoryStore()?.getUser('alice')).not.toBeNull();
    expect(byName.get('DC3')!.getDirectoryStore()?.dnsName).toBe('child.lab.local');
  });

  it('when its primary is not in the topology, it writes its whole directory and still reopens as a controller', async () => {
    const lab = await labWithDivergence();
    const alone = exportOf([lab.replica]);
    expect(alone.devices[0].activeDirectory?.baselineDeviceId).toBeUndefined();
    expect(alone.devices[0].activeDirectory?.delta?.entries.length).toBeGreaterThan(20);
    const { byName } = await reopen(alone);
    expect(byName.get('DC2')!.getDirectoryStore()?.getUser('bob')).not.toBeNull();
  });

  it('it enforces the forest schema, like the other controllers', async () => {
    const lab = await buildLab();
    lab.root.getDirectoryStore()!.newAttribute({ ldapDisplayName: 'labBadge', attributeSyntax: '2.5.5.12', isSingleValued: true });
    expect(lab.replica.getDirectoryStore()!.listSchemaAttributes().some((a) => a.ldapDisplayName === 'labBadge')).toBe(true);
  });
});

describe('what no directory holds: the forest-wide operation masters', () => {
  it('a fresh forest writes none; moved roles come back', async () => {
    const lab = await buildLab();
    expect(exportOf(lab.all, lab.connections).devices[0].activeDirectory?.forestFsmo).toBeUndefined();
    await lab.ps.root('Move-ADDirectoryServerOperationMasterRole -Identity "DC2.lab.local" -OperationMasterRole SchemaMaster, DomainNamingMaster -Confirm:$false');
    const json = exportOf(lab.all, lab.connections);
    expect(json.devices[0].activeDirectory?.forestFsmo).toEqual({ schemaMaster: 'DC2', domainNamingMaster: 'DC2' });
    const { byName } = await reopen(json);
    expect(byName.get('DC1')!.getForest()?.getFsmoRoles()).toEqual({ schemaMaster: 'DC2', domainNamingMaster: 'DC2' });
  });
});

describe('the factory twin is given the real addresses, so a controller does not write itself', () => {
  it('a root controller with an address does not write its own computer account', async () => {
    const lab = await buildLab();
    const dns = (exportOf(lab.all, lab.connections).devices[0].activeDirectory?.delta?.entries ?? []).map((e) => e.dn.toLowerCase());
    expect(dns).not.toContain('cn=dc1,ou=domain controllers,dc=lab,dc=local');
  });
});
