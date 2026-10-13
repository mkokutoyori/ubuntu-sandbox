/**
 * Le role Serveur de strategie reseau (NPS, NPAS) ne gardait rien d'une sauvegarde a l'autre : les clients RADIUS
 * (New-NpsRadiusClient) et le secret partage, les strategies reseau (New-NpsNetworkPolicy), les strategies de demande
 * de connexion (New-NpsConnectionRequestPolicy) et la comptabilite SQL (Set-NpsAccountingConfiguration -SqlLogging)
 * avec les enregistrements qu'elle avait deja recus revenaient vides : le role etait installe, plus aucun
 * equipement d'acces n'etait autorise, plus aucun utilisateur n'etait accepte.
 *
 * MESURE : NPS1 avec NPAS, un client RADIUS NAS (10.0.1.1, secret `shared`), un groupe local Sales avec npsuser,
 * une strategie reseau SalesPolicy (VLAN 200), une strategie de demande de connexion, la journalisation SQL activee
 * et une session de comptabilite enregistree ; sauvegarde puis reouverture : listes de clients et de strategies vides,
 * `authenticate('npsuser', ...)` depuis le routeur NAS refuse (le client n'est plus autorise, le secret est perdu),
 * la table RADIUS_ACCOUNTING n'existait plus.
 *
 * Corrige : WindowsNpsRole.exportState/restoreState (clients, secret partage lu dans la configuration de l'agent
 * RADIUS, strategies reseau, strategies de demande de connexion, comptabilite SQL avec ses enregistrements) ecrit par
 * un RolePersister contre le jumeau d'usine, qui n'a rien de tout cela. Un role installe mais jamais configure
 * n'ecrit rien. Les comptes qui servent d'annuaire a NPS (SAM locale ou Active Directory) etaient deja ecrits par
 * leurs propres sections ; la restauration ne leur ajoute aucune copie.
 *
 * Les comptes locaux eux-memes cachaient un defaut de la persistance precedente, trouve ici : le mot de passe d'un
 * compte vit dans un registre separe de la structure du compte (la structure ne porte que « x »), et la sauvegarde ne
 * sauvait que la structure : apres reouverture un utilisateur local cree par le labo n'avait plus de mot de passe, donc
 * plus de connexion possible, et un mot de passe modifie repartait a sa valeur d'usine. Ils sont maintenant ecrits
 * (en delta : seuls ceux des comptes qui different de l'usine).
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store, src/network et src/powershell) : voir le message de
 * commit pour le decompte. Passent des deux cotes, avec leur raison : le temoin « un NPS jamais configure n'ecrit
 * rien », le temoin « un compte intact n'ecrit rien », « le secret est celui qui a ete pose » et « un client retire
 * le reste » (avant, la perte des mots de passe locaux refusait deja tout le monde : le refus n'y prouve rien ; c'est
 * le cas « un NPS sans aucun client ne repond a personne » qui discrimine la fermeture par defaut).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const shellOf = (device: WindowsServer) => {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab(options: { configure?: boolean } = {}) {
  const { configure = true } = options;
  const nps = new WindowsServer('NPS1');
  const nas = new CiscoRouter('NAS');
  const connections = [buildConnection(nps, nps.getPorts()[0].getName(), nas, 'GigabitEthernet0/0', 'ethernet')!];
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  nps.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  nps.setCurrentUser('Administrator');
  const ps = shellOf(nps);
  await ps('Install-WindowsFeature NPAS');
  if (configure) {
    await ps('New-NpsRadiusClient -Name NAS -Address 10.0.1.1 -SharedSecret shared');
    await ps('New-LocalUser -Name npsuser -Password "N3twork!Pass"');
    await ps('New-LocalGroup -Name Sales');
    await ps('Add-LocalGroupMember -Group Sales -Member npsuser');
    await ps('New-NpsNetworkPolicy -Name SalesPolicy -Group Sales -VlanId 200');
    await ps('New-NpsConnectionRequestPolicy -Name AnyTime -UserGroups Sales');
    await ps('Set-NpsAccountingConfiguration -SqlLogging $true');
    nas.getRadiusClient().addServer('10.0.1.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    nas.getRadiusAccountingClient().addServer('10.0.1.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    const session = nas.getRadiusAccountingClient().startSession('npsuser');
    nas.getRadiusAccountingClient().stopSession(session!);
  }
  return { nps, nas, all: [nps, nas] as Equipment[], connections, ps };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2]) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>, secret = 'shared') {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d]));
  const nps = byName.get('NPS1') as WindowsServer;
  const nas = byName.get('NAS') as CiscoRouter;
  nps.setCurrentUser('Administrator');
  nas.getRadiusClient().addServer('10.0.1.2', secret, { timeoutMs: 200, retransmit: 0 });
  nas.getRadiusAccountingClient().addServer('10.0.1.2', secret, { timeoutMs: 200, retransmit: 0 });
  return { nps, nas, role: nps.getNpsRole()! };
}

describe('an NPS that was never configured writes nothing', () => {
  it('witness: no NPS section', async () => {
    const lab = await buildLab({ configure: false });
    expect(exportOf(lab.all, lab.connections).devices[0].windowsRoles?.nps).toBeUndefined();
  });
});

describe('clients, secret and policies are back, and they decide over the wire', () => {
  it('the clients and the policies are listed as they were', async () => {
    const lab = await buildLab();
    const { role } = await reopen(exportOf(lab.all, lab.connections));
    expect(role.listNasClients()).toEqual([{ name: 'NAS', ipAddress: '10.0.1.1' }]);
    expect(role.listNetworkPolicies()).toEqual([{ name: 'SalesPolicy', group: 'Sales', vlanId: 200 }]);
    expect(role.listConnectionRequestPolicies().map((p) => p.name)).toEqual(['AnyTime']);
  });

  it('the NAS is still authorised and a Sales user is accepted by a real Access-Request', async () => {
    const lab = await buildLab();
    expect(await lab.nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass')).toBe(true);
    const { nas } = await reopen(exportOf(lab.all, lab.connections));
    expect(await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass')).toBe(true);
    expect(await nas.getRadiusClient().authenticate('npsuser', 'wrong')).toBe(false);
  });

  it('the shared secret is the one that was set: a NAS holding another secret is refused', async () => {
    const lab = await buildLab();
    const { nas } = await reopen(exportOf(lab.all, lab.connections), 'not-the-secret');
    expect(await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass')).toBe(false);
  });

  it('an NPS with no RADIUS client at all answers nobody, even a valid user (fail closed)', async () => {
    const lab = await buildLab();
    await lab.ps('Remove-NpsRadiusClient -Name NAS');
    expect(await lab.nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass')).toBe(false);
  });

  it('a removed client stays removed: the NAS is no longer authorised', async () => {
    const lab = await buildLab();
    await lab.ps('Remove-NpsRadiusClient -Name NAS');
    const { nas, role } = await reopen(exportOf(lab.all, lab.connections));
    expect(role.listNasClients()).toEqual([]);
    expect(await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass')).toBe(false);
  });

  it('the section holds the NPS configuration only, not the accounts it reads', async () => {
    const lab = await buildLab();
    const nps = exportOf(lab.all, lab.connections).devices[0].windowsRoles?.nps;
    expect(Object.keys(nps ?? {}).sort()).toEqual(['connectionRequestPolicies', 'nasClients', 'networkPolicies', 'sharedSecret', 'sqlAccounting']);
  });
});

describe('the local accounts NPS authenticates against keep their passwords', () => {
  it('a local user created by the lab can still log on with its password, and a changed built-in password is the changed one', async () => {
    const lab = await buildLab();
    await lab.ps('Set-LocalUser -Name Administrator -Password (ConvertTo-SecureString "Ch4nged!Admin" -AsPlainText -Force)');
    const { nps } = await reopen(exportOf(lab.all, lab.connections));
    const accounts = nps.getUserManager();
    expect(accounts.getPlaintextPassword('npsuser')).toBe('N3twork!Pass');
    expect(accounts.getPlaintextPassword('Administrator')).toBe('Ch4nged!Admin');
  });

  it('witness: an account nobody touched writes no password', async () => {
    const lab = await buildLab({ configure: false });
    expect(exportOf(lab.all, lab.connections).devices[0].windowsAccounts).toBeUndefined();
  });
});

describe('the SQL accounting table and its records', () => {
  it('the records already received come back, and logging goes on appending to them', async () => {
    const lab = await buildLab();
    const before = lab.nps.getNpsRole()!.queryAccounting('SELECT USERNAME, STATUS FROM RADIUS_ACCOUNTING')!.rows;
    expect(before.length).toBeGreaterThan(0);
    const { nas, role } = await reopen(exportOf(lab.all, lab.connections));
    expect(role.isSqlAccountingEnabled()).toBe(true);
    expect(role.queryAccounting('SELECT USERNAME, STATUS FROM RADIUS_ACCOUNTING')!.rows).toEqual(before);
    const session = nas.getRadiusAccountingClient().startSession('npsuser');
    nas.getRadiusAccountingClient().stopSession(session!);
    expect(role.queryAccounting('SELECT USERNAME FROM RADIUS_ACCOUNTING')!.rows.length).toBeGreaterThan(before.length);
  });

  it('logging switched off after having been on keeps its table but stops appending', async () => {
    const lab = await buildLab();
    await lab.ps('Set-NpsAccountingConfiguration -SqlLogging $false');
    const count = lab.nps.getNpsRole()!.queryAccounting('SELECT * FROM RADIUS_ACCOUNTING')!.rows.length;
    const { nas, role } = await reopen(exportOf(lab.all, lab.connections));
    expect(role.isSqlAccountingEnabled()).toBe(false);
    const session = nas.getRadiusAccountingClient().startSession('npsuser');
    nas.getRadiusAccountingClient().stopSession(session!);
    expect(role.queryAccounting('SELECT * FROM RADIUS_ACCOUNTING')!.rows).toHaveLength(count);
  });
});
