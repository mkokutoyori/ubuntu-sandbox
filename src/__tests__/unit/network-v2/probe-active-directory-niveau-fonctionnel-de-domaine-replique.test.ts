/**
 * Le niveau fonctionnel d'un domaine n'etait qu'un champ du DirectoryStore du premier controleur, pose a la
 * promotion de la foret : un controleur supplementaire (Install-ADDSDomainController) repartait au niveau par defaut
 * (Windows2016Domain) quel que soit celui du domaine, et la sauvegarde ne pouvait pas l'ecrire pour lui.
 *
 * MESURE : Install-ADDSForest -ForestMode Win2008R2 -DomainMode Win2012 sur DC1, DC2 promu controleur supplementaire,
 * DC3 domaine enfant : `Get-ADDomain` rendait Windows2012Domain sur DC1 mais Windows2016Domain sur DC2, avant comme
 * apres reouverture ; sur DC1 la valeur ne survivait que parce que la promotion est rejouee avec ses arguments.
 *
 * Corrige a la source, comme dans un vrai annuaire : le niveau est l'attribut msDS-Behavior-Version de la racine du
 * domaine (2 a 7, le rang du niveau). Un attribut se replique, donc le controleur supplementaire le recoit au tirage
 * initial ; il fait partie des entrees du delta, donc la sauvegarde l'ecrit sans code propre. Le champ est devenu un
 * accesseur de cet attribut, il n'y a pas de seconde copie.
 *
 * Discriminee contre l'etat d'avant (`git stash` de src/store et src/network) : 3 cas sur 6 tombent. Les 3 qui
 * passent des deux cotes : le temoin « la racine garde son niveau » (la promotion rejouee le portait deja), le domaine
 * enfant (son niveau par defaut etait deja le bon) et le niveau par defaut (rien a ecrire dans les deux etats).
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
import type { Equipment } from '@/network';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetForestRegistry();
});

const SAFE = '(ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const MODE = 'Get-ADDomain | Select-Object -ExpandProperty DomainMode';

const shellOf = (device: WindowsServer) => {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
};

async function buildLab(forestArguments: string) {
  const root = new WindowsServer('DC1');
  const replica = new WindowsServer('DC2');
  const child = new WindowsServer('DC3');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  const servers = [root, replica, child];
  const connections = servers.map((s, i) => buildConnection(s, s.getPorts()[0].getName(), hub, hub.getPorts()[i].getName(), 'ethernet')!);
  const mask = new SubnetMask('255.255.255.0');
  servers.forEach((s, i) => {
    s.getPorts()[0].configureIP(new IPAddress(`192.168.90.${10 + i}`), mask);
    s.setCurrentUser('Administrator');
  });
  const ps = { root: shellOf(root), replica: shellOf(replica), child: shellOf(child) };
  await ps.root('Install-WindowsFeature AD-Domain-Services');
  await ps.root(`Install-ADDSForest -DomainName lab.local ${forestArguments} -SafeModeAdministratorPassword ${SAFE}`);
  await ps.replica('Install-WindowsFeature AD-Domain-Services');
  await ps.replica(`Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.90.10 -SafeModeAdministratorPassword ${SAFE}`);
  await ps.child('Install-WindowsFeature AD-Domain-Services');
  await ps.child(`New-ADDomain -NewDomainName child.lab.local -ParentDomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.90.10 -SafeModeAdministratorPassword ${SAFE}`);
  return { root, replica, child, hub, all: [...servers, hub] as Equipment[], connections, ps };
}

const exportOf = (devices: Equipment[], connections: Parameters<typeof exportTopology>[2]) =>
  exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), connections);

async function reopen(json: ReturnType<typeof exportOf>) {
  const back = await importTopology(JSON.parse(JSON.stringify(json)));
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d as WindowsServer]));
  for (const server of byName.values()) if (server instanceof WindowsServer) server.setCurrentUser('Administrator');
  return { ps: { root: shellOf(byName.get('DC1')!), replica: shellOf(byName.get('DC2')!), child: shellOf(byName.get('DC3')!) } };
}

describe('the domain functional level is an attribute of the domain, so it is replicated and saved', () => {
  it('witness: the controller that was promoted with a level keeps it, before and after reopening', async () => {
    const lab = await buildLab('-ForestMode Win2008R2 -DomainMode Win2012');
    expect(await lab.ps.root(MODE)).toContain('Windows2012Domain');
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps.root(MODE)).toContain('Windows2012Domain');
  });

  it('an additional controller reports the level of its domain as soon as it is promoted', async () => {
    const lab = await buildLab('-ForestMode Win2008R2 -DomainMode Win2012');
    expect(await lab.ps.replica(MODE)).toContain('Windows2012Domain');
  });

  it('and still does after reopening', async () => {
    const lab = await buildLab('-ForestMode Win2008R2 -DomainMode Win2012');
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps.replica(MODE)).toContain('Windows2012Domain');
  });

  it('a child domain keeps the level it was created with, which is its own', async () => {
    const lab = await buildLab('-ForestMode Win2008R2 -DomainMode Win2012');
    expect(await lab.ps.child(MODE)).toContain('Windows2016Domain');
    const { ps } = await reopen(exportOf(lab.all, lab.connections));
    expect(await ps.child(MODE)).toContain('Windows2016Domain');
  });

  it('the level is read from the attribute: there is no second copy to disagree with it', async () => {
    const lab = await buildLab('-ForestMode Win2008R2 -DomainMode Win2012');
    const root = lab.root.getDirectoryStore()!;
    expect(root.getTree().getByDn(root.getTree().getRootDn())!.attributes.get('msds-behavior-version')).toEqual(['5']);
    expect(lab.replica.getDirectoryStore()!.domainMode).toBe('Windows2012Domain');
  });

  it('the default level writes nothing: the attribute is part of the seeded root, the twin has it too', async () => {
    const lab = await buildLab('');
    const [rootEntry, replicaEntry] = exportOf(lab.all, lab.connections).devices;
    const rootDns = (rootEntry.activeDirectory?.delta?.entries ?? []).map((e) => e.dn.toLowerCase());
    const replicaDns = (replicaEntry.activeDirectory?.delta?.entries ?? []).map((e) => e.dn.toLowerCase());
    expect(rootDns).not.toContain('dc=lab,dc=local');
    expect(replicaDns).not.toContain('dc=lab,dc=local');
    expect(await lab.ps.replica(MODE)).toContain('Windows2016Domain');
  });
});
