/**
 * Un controleur de domaine rouvert avait perdu son etat de REPLICATION : son identite d'invocation etait retiree au
 * hasard a chaque construction, son vecteur de hauts niveaux (ce qu'il a deja absorbe de chaque partenaire) etait
 * vide, ses options NTDS (`repadmin /options`) et son journal de replication aussi, et les objets semes par la
 * promotion changeaient d'objectGUID et d'heure de dernier changement de mot de passe a chaque ouverture.
 *
 * MESURE : DC1 (foret lab.local) et DC2 (Install-ADDSDomainController) sur un commutateur, une OU creee sur DC1, un
 * tirage de DC2 vers DC1, DISABLE_SPN_REGISTRATION pose sur DC2, sauvegarde puis reouverture :
 *   - les deux identifiants d'invocation avaient change ;
 *   - un tirage de DC2 vers DC1 alors que tout etait deja replique appliquait 47 objets au lieu de 0 ;
 *   - `repadmin /showrepl` sur DC2 repondait « (nothing yet) » aux voisins entrants et sortants, le journal (3
 *     entrees) et les compteurs (2 tirages reussis, 45 objets appliques) etaient a zero, `repadmin /options`
 *     repondait « (none) » ;
 *   - l'objectGUID du compte Administrator changeait, son pwdLastSet (donc son vieillissement) repartait de l'heure
 *     d'ouverture.
 *
 * Corrige : l'identite d'invocation, l'heure de promotion et le compteur de GUID sont des donnees de la promotion
 * (rejouee a l'identique : le GUID d'un objet est derive de l'identite du controleur et d'un compteur, l'horloge de
 * l'annuaire est epinglee a l'heure de promotion le temps du rejeu) ; le vecteur de hauts niveaux, les options
 * NTDS et le journal avec ses compteurs sont ecrits contre le jumeau d'usine, vide sur ces trois points. Un
 * controleur qui n'a jamais replique n'ecrit rien de tout cela. Les horodatages d'estampille d'une entree viennent
 * maintenant de l'horloge de la machine qui l'ecrit, comme le reste de l'annuaire, et non de l'horloge globale.
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 10 cas sur 14 tombent. Les 4 qui
 * passent des deux cotes : le temoin « une racine qui n'a jamais replique n'ecrit rien », le temoin de laboratoire
 * « sans reouverture, le meme utilisateur est tire avec le meme compte » (il fixe le 2 attendu : l'utilisateur et le
 * groupe qu'il rejoint), l'export qui laisse l'identite vivante intacte (structurel) et l'unicite des GUID (avant,
 * ils etaient aleatoires donc uniques).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { resetForestRegistry } from '@/network/devices/windows/server/ad/forest/Forest';
import { pullReplication } from '@/network/devices/windows/server/ad/replication/ReplicationSession';
import { parseDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';
import type { Equipment } from '@/network';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetForestRegistry();
});

afterEach(() => { __resetSimulationClock(); });

const SAFE = '(ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const USER_PASSWORD = '(ConvertTo-SecureString "Passw0rd!123" -AsPlainText -Force)';
const ROOT = '192.168.90.10';

const shellOf = (device: WindowsServer) => {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab(options: { replicate?: boolean } = {}) {
  const { replicate = true } = options;
  const root = new WindowsServer('DC1');
  const replica = new WindowsServer('DC2');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  const servers = [root, replica];
  const connections = servers.map((s, i) => buildConnection(s, s.getPorts()[0].getName(), hub, hub.getPorts()[i].getName(), 'ethernet')!);
  const mask = new SubnetMask('255.255.255.0');
  servers.forEach((s, i) => {
    s.getPorts()[0].configureIP(new IPAddress(`192.168.90.${10 + i}`), mask);
    s.setCurrentUser('Administrator');
  });
  const ps = { root: shellOf(root), replica: shellOf(replica) };
  await ps.root('Install-WindowsFeature AD-Domain-Services');
  await ps.root(`Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword ${SAFE}`);
  await ps.replica('Install-WindowsFeature AD-Domain-Services');
  await ps.replica(`Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server ${ROOT} -SafeModeAdministratorPassword ${SAFE}`);
  await ps.root('New-ADOrganizationalUnit -Name Staff -Path "DC=lab,DC=local"');
  if (replicate) {
    pullReplication(replica.getTcpStack(), ROOT, replica.getDirectoryStore()!);
    await ps.replica('repadmin /options DC2 +DISABLE_SPN_REGISTRATION');
    replica.replicateFrom(ROOT);
  }
  return { root, replica, hub, all: [root, replica, hub] as Equipment[], connections, ps };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2]) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>) {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d]));
  const root = byName.get('DC1') as WindowsServer;
  const replica = byName.get('DC2') as WindowsServer;
  root.setCurrentUser('Administrator');
  replica.setCurrentUser('Administrator');
  return { root, replica, ps: { root: shellOf(root), replica: shellOf(replica) } };
}

const entryOf = (server: WindowsServer, dn: string) => server.getDirectoryStore()!.getTree().getByDn(parseDN(dn))!;
const pull = (from: WindowsServer) => pullReplication(from.getTcpStack(), ROOT, from.getDirectoryStore()!);

describe('a controller keeps its replication identity', () => {
  it('the invocation identifiers are the ones the partners already know', async () => {
    const lab = await buildLab();
    const { root, replica } = await reopen(exportOf(lab.all, lab.connections));
    expect(root.getDirectoryStore()!.getInvocationId()).toBe(lab.root.getDirectoryStore()!.getInvocationId());
    expect(replica.getDirectoryStore()!.getInvocationId()).toBe(lab.replica.getDirectoryStore()!.getInvocationId());
  });

  it('exporting does not change the identity of the live controllers', async () => {
    const lab = await buildLab();
    const before = lab.replica.getDirectoryStore()!.getInvocationId();
    exportOf(lab.all, lab.connections);
    expect(lab.replica.getDirectoryStore()!.getInvocationId()).toBe(before);
  });

  it('the objects a promotion seeds keep their GUID, their stamp and their USN', async () => {
    const lab = await buildLab();
    const dn = 'CN=Administrator,CN=Users,DC=lab,DC=local';
    const before = entryOf(lab.root, dn);
    const { root } = await reopen(exportOf(lab.all, lab.connections));
    const after = entryOf(root, dn);
    expect(after.attributes.get('objectguid')).toEqual(before.attributes.get('objectguid'));
    expect(after.replMeta).toEqual(before.replMeta);
  });

  it('the password age of an account nobody touched does not restart when the file is opened an hour later', async () => {
    const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
    const lab = await buildLab();
    const dn = 'CN=Administrator,CN=Users,DC=lab,DC=local';
    const before = new Date(entryOf(lab.root, dn).attributes.get('pwdlastset')![0]).getTime();
    const json = exportOf(lab.all, lab.connections);
    await clock.advance(3_600_000);
    const { root } = await reopen(json);
    const after = new Date(entryOf(root, dn).attributes.get('pwdlastset')![0]).getTime();
    expect(Math.abs(after - before)).toBeLessThan(1000);
  });

  it('a GUID is never handed out twice: a new object after reopening gets a fresh one', async () => {
    const lab = await buildLab();
    const { root, ps } = await reopen(exportOf(lab.all, lab.connections));
    await ps.root(`New-ADUser -Name carol -SamAccountName carol -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    const guids = root.getDirectoryStore()!.exportSnapshot().entries.map((e) => e.attributes.objectguid?.[0]).filter(Boolean);
    expect(new Set(guids).size).toBe(guids.length);
  });
});

describe('a controller remembers how far it has replicated', () => {
  it('a pull of what it already has applies nothing', async () => {
    const lab = await buildLab();
    expect(pull(lab.replica).applied).toBe(0);
    const { replica } = await reopen(exportOf(lab.all, lab.connections));
    expect(pull(replica)).toMatchObject({ ok: true, applied: 0 });
  });

  it('what happened on the partner meanwhile is pulled once, and only that: the user and the group it joined', async () => {
    const lab = await buildLab();
    const { root, replica, ps } = await reopen(exportOf(lab.all, lab.connections));
    await ps.root(`New-ADUser -Name dave -SamAccountName dave -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    expect(root.getDirectoryStore()!.getUser('dave')).not.toBeNull();
    expect(pull(replica)).toMatchObject({ ok: true, applied: 2 });
    expect(replica.getDirectoryStore()!.getUser('dave')).not.toBeNull();
    expect(pull(replica).applied).toBe(0);
  });

  it('control: without any reopening, the same user is pulled with the same count', async () => {
    const lab = await buildLab();
    await lab.ps.root(`New-ADUser -Name dave -SamAccountName dave -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    expect(pull(lab.replica)).toMatchObject({ ok: true, applied: 2 });
  });

  it('what the partner had written before the save but the replica had not pulled stays pending', async () => {
    const lab = await buildLab();
    await lab.ps.root(`New-ADUser -Name erin -SamAccountName erin -AccountPassword ${USER_PASSWORD} -Enabled $true`);
    const { replica } = await reopen(exportOf(lab.all, lab.connections));
    expect(replica.getDirectoryStore()!.getUser('erin')).toBeNull();
    expect(pull(replica)).toMatchObject({ ok: true, applied: 2 });
    expect(replica.getDirectoryStore()!.getUser('erin')).not.toBeNull();
  });

  it('repadmin /showrepl still lists the partner, the last attempt and the USN reached', async () => {
    const lab = await buildLab();
    const before = await lab.ps.replica('repadmin /showrepl');
    expect(before).toContain('was successful');
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    const after = await ps.replica('repadmin /showrepl');
    expect(after).not.toContain('(nothing yet)');
    expect(after).toContain('DC1');
    expect(after).toMatch(/USNs: \d+ \/ current/);
    expect(after).toContain(`DSA invocationID: ${lab.replica.getDirectoryStore()!.getInvocationId()}`);
  });
});

describe('the settings and the journal of replication', () => {
  it('a DC option posed with repadmin /options is still posed, and still decides', async () => {
    const lab = await buildLab();
    await lab.ps.replica('repadmin /options DC2 +DISABLE_INBOUND_REPL');
    const { replica, ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(replica.getNtdsOptions().sort()).toEqual(['DISABLE_INBOUND_REPL', 'DISABLE_SPN_REGISTRATION']);
    expect(await ps.replica('repadmin /options DC2')).toContain('DISABLE_INBOUND_REPL');
    expect(replica.replicateFrom(ROOT).ok).toBe(false);
  });

  it('the journal and its counters come back as they were', async () => {
    const lab = await buildLab();
    const log = lab.replica.getReplicationLog();
    const stats = lab.replica.getReplicationSignals().stats.get();
    expect(log.length).toBeGreaterThan(1);
    const { replica } = await reopen(exportOf(lab.all, lab.connections));
    expect(replica.getReplicationLog()).toEqual(log);
    expect(replica.getReplicationSignals().stats.get()).toEqual(stats);
  });

  it('the controller that served the pulls remembers having served them', async () => {
    const lab = await buildLab();
    const served = lab.root.getReplicationSignals().stats.get().served;
    expect(served).toBeGreaterThan(0);
    const { root } = await reopen(exportOf(lab.all, lab.connections));
    expect(root.getReplicationSignals().stats.get().served).toBe(served);
  });

  it('witness: a root that never replicated writes no vector, no option and no journal', async () => {
    const alone = new WindowsServer('DC1');
    alone.setCurrentUser('Administrator');
    const ps = shellOf(alone);
    await ps('Install-WindowsFeature AD-Domain-Services');
    await ps(`Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword ${SAFE}`);
    const section = exportOf([alone], []).devices[0].activeDirectory!;
    expect(section.ntdsOptions).toBeUndefined();
    expect(section.replication).toBeUndefined();
    expect(section.delta?.highWatermark ?? []).toEqual([]);
  });
});
