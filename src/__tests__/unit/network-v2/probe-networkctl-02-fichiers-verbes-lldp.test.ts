/**
 * Probes — networkctl : les fichiers, les verbes d'action, et LLDP.
 *
 * Phases 3, 4 et 5 de `docs/PRD-networkctl.md`.
 *
 * La phase 5 n'a de sens que si l'hôte parle réellement LLDP : un rendu
 * alimenté par une table toujours vide serait correct au sens strict et
 * inutile en pratique. C'est pourquoi le voisin est ici découvert à
 * travers un vrai câble, depuis un vrai commutateur qui annonce.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  discoverNetworkdFiles,
  matchNetworkFile,
} from '@/network/devices/linux/net/NetworkdFiles';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 30_000;
const MASK = new SubnetMask('255.255.255.0');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function lab(): Promise<{ pc: LinuxPC; sw: CiscoSwitch }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  pc.powerOn();
  sw.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  pc.configureInterface('eth0', new IPAddress('10.0.0.5'), MASK);
  return { pc, sw };
}

function vfsOf(pc: LinuxPC) {
  return (pc as unknown as { executor: { vfs: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem } })
    .executor.vfs;
}

describe('Scénario 7 — le répertoire que la sortie nommait déjà', () => {
  it('le .link par défaut existe pour de bon, il n\'est plus une chaîne', async () => {
    const { pc } = await lab();
    const chemin = '/usr/lib/systemd/network/99-default.link';

    expect(
      await pc.executeCommand(`test -f ${chemin} && echo present`),
      'networkctl nommait ce fichier sans qu\'il existe',
    ).toContain('present');
    expect(await pc.executeCommand('networkctl status eth0')).toContain(chemin);
  }, LONG);

  it('/etc/systemd/network existe, prêt à recevoir une configuration', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('test -d /etc/systemd/network && echo present')).toContain('present');
  }, LONG);

  it('le tri lexicographique fait gagner un 10- sur un 99-', async () => {
    const { pc } = await lab();
    const vfs = vfsOf(pc);
    vfs.createFileAt('/etc/systemd/network/99-fallback.network',
      '[Match]\nName=eth0\n\n[Network]\nDHCP=yes\n', 0o644, 0, 0);
    vfs.createFileAt('/etc/systemd/network/10-prioritaire.network',
      '[Match]\nName=eth0\n\n[Network]\nAddress=10.0.0.5/24\n', 0o644, 0, 0);

    const retenu = matchNetworkFile(discoverNetworkdFiles(vfs), 'eth0');
    expect(retenu?.basename, 'première correspondance dans l\'ordre des noms').toBe('10-prioritaire.network');
  }, LONG);

  it('/etc masque son homonyme d\'/usr/lib', async () => {
    const { pc } = await lab();
    const vfs = vfsOf(pc);
    vfs.mkdirp('/usr/lib/systemd/network', 0o755, 0, 0);
    vfs.createFileAt('/usr/lib/systemd/network/50-vendeur.network',
      '[Match]\nName=eth0\n\n[Network]\nDHCP=yes\n', 0o644, 0, 0);
    vfs.createFileAt('/etc/systemd/network/50-vendeur.network',
      '[Match]\nName=eth0\n\n[Network]\nAddress=192.168.1.1/24\n', 0o644, 0, 0);

    const retenu = matchNetworkFile(discoverNetworkdFiles(vfs), 'eth0');
    expect(retenu?.path).toBe('/etc/systemd/network/50-vendeur.network');
  }, LONG);

  it('un [Match] par glob retient bien l\'interface', async () => {
    const { pc } = await lab();
    const vfs = vfsOf(pc);
    vfs.createFileAt('/etc/systemd/network/20-cablees.network',
      '[Match]\nName=en* eth*\n\n[Network]\nDHCP=yes\n', 0o644, 0, 0);

    const fichiers = discoverNetworkdFiles(vfs);
    expect(matchNetworkFile(fichiers, 'eth0')?.basename).toBe('20-cablees.network');
    expect(matchNetworkFile(fichiers, 'wlan0'), 'wlan0 ne correspond à aucun motif').toBeNull();
  }, LONG);

  it('`cat` rend le contenu précédé de son chemin', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('sudo networkctl cat eth0');
    expect(out).toContain('# /usr/lib/systemd/network/99-default.link');
    expect(out).toContain('OriginalName=*');
  }, LONG);
});

describe('Scénario 8 — les verbes d\'action agissent vraiment', () => {
  it('`down` exige les privilèges', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('networkctl down eth0')).toContain('Permission denied');
    expect(
      pc.getPort('eth0')!.getIsUp(),
      'refusée, la commande ne doit rien avoir changé',
    ).toBe(true);
  }, LONG);

  it('`down` puis `up` traversent le même chemin que `ip link set`', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo networkctl down eth0');
    expect(pc.getPort('eth0')!.getIsUp()).toBe(false);

    await pc.executeCommand('sudo networkctl up eth0');
    expect(pc.getPort('eth0')!.getIsUp()).toBe(true);
  }, LONG);

  it('un lien inconnu est refusé et le code de retour le dit', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('sudo networkctl up nosuchif; echo rc=$?');
    expect(out).toContain("Cannot find device 'nosuchif'.");
    expect(out).toContain('rc=1');
  }, LONG);

  it('supprimer un lien physique est refusé, comme chez networkd', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('sudo networkctl delete eth0');
    expect(out).toMatch(/not permitted|not supported/i);
    expect(pc.getPorts().find((p) => p.getName() === 'eth0'), 'le port est toujours là').toBeDefined();
  }, LONG);

  it('`label` rend la table de la RFC 3484', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl label');
    expect(out).toContain('LABEL');
    expect(out).toContain('::1/128');
    expect(out).toContain('fc00::/7');
  }, LONG);

  it('`reload` ne réclame pas de cible', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('sudo networkctl reload; echo rc=$?');
    expect(out).toContain('rc=0');
  }, LONG);
});

describe('Scénario 9 — LLDP : un voisin réellement découvert', () => {
  it('le poste voit le commutateur auquel il est câblé', async () => {
    const { pc, sw } = await lab();
    for (const c of ['enable', 'configure terminal', 'lldp run', 'end']) {
      await sw.executeCommand(c);
    }
    await pause(500);

    const out = await pc.executeCommand('networkctl lldp');
    expect(out, 'le nom vient de la trame, pas d\'un gabarit').toContain('SW1');
    expect(out).toContain('eth0');
    expect(out).toMatch(/Bridge/);
    expect(out).toContain('1 neighbors listed.');
  }, LONG);

  it('sans annonce en face, la table reste vide et le dit', async () => {
    const { pc } = await lab();
    await pause(300);
    const out = await pc.executeCommand('networkctl lldp');
    expect(
      out,
      'LLDP est désactivé par défaut sur un Catalyst : rien à découvrir',
    ).toContain('0 neighbors listed.');
  }, LONG);

  it('l\'hôte écoute par défaut mais n\'émet pas — LLDP=yes, EmitLLDP=no', async () => {
    const { pc, sw } = await lab();
    for (const c of ['enable', 'configure terminal', 'lldp run', 'end']) {
      await sw.executeCommand(c);
    }
    await pause(500);

    expect(
      pc.getLldpNeighbors().length,
      'la réception marche sans rien configurer',
    ).toBeGreaterThan(0);

    // Mesuré sur la table de l'agent du switch, pas sur `show lldp
    // neighbors` : cet affichage FUSIONNE les voisins appris par trame
    // avec ceux déduits du câblage (`CiscoCommonShow.lldpNeighbours`), et
    // montre donc le pair du câble même s'il n'a jamais rien annoncé.
    // C'est un écart pré-existant de l'affichage du switch, étranger à ce
    // PRD ; l'assertion vise ici l'émission, donc la table réelle.
    expect(
      sw.getLldpNeighbors().map((n) => n.remoteHost),
      'le poste ne s\'annonce pas de lui-même, comme networkd',
    ).not.toContain('PC1');
  }, LONG);

  it('`setLldpEmission(true)` fait vraiment parvenir une trame au voisin', async () => {
    const { pc, sw } = await lab();
    for (const c of ['enable', 'configure terminal', 'lldp run', 'end']) {
      await sw.executeCommand(c);
    }
    expect(sw.getLldpNeighbors().map((n) => n.remoteHost)).not.toContain('PC1');

    pc.setLldpEmission(true);
    await pause(500);

    expect(
      sw.getLldpNeighbors().map((n) => n.remoteHost),
      'la trame doit être réellement partie et avoir été apprise',
    ).toContain('PC1');
  }, LONG);
});
