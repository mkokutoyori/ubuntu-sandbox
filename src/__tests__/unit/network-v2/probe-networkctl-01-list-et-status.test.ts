/**
 * Probes — networkctl : ce qu'il affiche est constaté, pas recopié.
 *
 * Phases 1, 2 et 6 de `docs/PRD-networkctl.md`.
 *
 * Le test central est une CORRÉLATION entre `networkctl list` et
 * `ip -br link` sur la même machine au même instant. C'est le défaut
 * d'origine : `list` annonçait « routable configured » pour des liens que
 * `ip` décrivait `NO-CARRIER … state DOWN`. Une assertion sur une chaîne
 * figée (`toContain('routable')`) n'aurait rien attrapé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 30_000;
const MASK = new SubnetMask('255.255.255.0');

/** PC1 câblé à SW1 par eth0 ; eth1..eth3 restent libres, sans porteuse. */
async function lab(): Promise<{ pc: LinuxPC; sw: CiscoSwitch }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  pc.powerOn();
  sw.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  pc.configureInterface('eth0', new IPAddress('10.0.0.5'), MASK);
  return { pc, sw };
}

/** Table `networkctl list` en lignes découpées, légende retirée. */
function listRows(sortie: string): Array<Record<string, string>> {
  const lignes = sortie.split('\n').filter((l) => l.trim() && !/links listed/.test(l));
  const entete = lignes[0].trim().split(/\s+/);
  return lignes.slice(1).map((l) => {
    const cols = l.trim().split(/\s+/);
    return Object.fromEntries(entete.map((h, i) => [h, cols[i]]));
  });
}

/** Ce que `ip -br link` dit de la porteuse de chaque interface. */
function porteuseSelonIp(sortie: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const m of sortie.matchAll(/^\s*\d+:\s+(\S+):\s+<([^>]*)>/gm)) {
    out.set(m[1], m[2].split(',').includes('LOWER_UP'));
  }
  return out;
}

describe('Scénario 1 — `list` s\'accorde avec le noyau', () => {
  it('un lien sans porteuse n\'est jamais annoncé routable', async () => {
    const { pc } = await lab();
    const lignes = listRows(await pc.executeCommand('networkctl list'));
    const porteuse = porteuseSelonIp(await pc.executeCommand('ip -br link'));

    expect(lignes.length).toBeGreaterThan(1);
    for (const ligne of lignes) {
      if (ligne.LINK === 'lo') continue;
      const aPorteuse = porteuse.get(ligne.LINK);
      expect(
        aPorteuse,
        `ip ne connaît pas ${ligne.LINK}, les deux commandes ne listent pas les mêmes liens`,
      ).not.toBeUndefined();
      if (aPorteuse) {
        expect(ligne.OPERATIONAL, `${ligne.LINK} porte, il ne peut pas être no-carrier`)
          .not.toBe('no-carrier');
      } else {
        expect(ligne.OPERATIONAL, `${ligne.LINK} ne porte pas, il ne peut pas être routable`)
          .not.toBe('routable');
      }
    }
  }, LONG);

  it('l\'accord tient encore après avoir descendu l\'interface', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo networkctl down eth0');

    const eth0 = listRows(await pc.executeCommand('networkctl list')).find((l) => l.LINK === 'eth0');
    const ipLink = await pc.executeCommand('ip -br link');

    expect(eth0!.OPERATIONAL, 'administrativement bas, donc `off` et non `no-carrier`').toBe('off');
    expect(
      /eth0:\s+<[^>]*>/.exec(ipLink)![0],
      'et ip doit avoir perdu le drapeau UP en même temps',
    ).not.toContain('UP');
  }, LONG);

  it('le lien remonte des deux côtés à la fois', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo networkctl down eth0');
    await pc.executeCommand('sudo networkctl up eth0');

    const eth0 = listRows(await pc.executeCommand('networkctl list')).find((l) => l.LINK === 'eth0');
    expect(eth0!.OPERATIONAL).toBe('routable');
    expect(porteuseSelonIp(await pc.executeCommand('ip -br link')).get('eth0')).toBe(true);
  }, LONG);
});

describe('Scénario 2 — la boucle locale existe aussi pour networkctl', () => {
  it('lo est le lien 1, loopback et non géré', async () => {
    const { pc } = await lab();
    const lo = listRows(await pc.executeCommand('networkctl list')).find((l) => l.LINK === 'lo');

    expect(lo, 'lo est rendu par ip ; l\'ignorer était une divergence').toBeDefined();
    expect(lo!.IDX).toBe('1');
    expect(lo!.TYPE).toBe('loopback');
    expect(lo!.SETUP, 'aucun .network ne réclame la boucle locale').toBe('unmanaged');
  }, LONG);

  it('`status lo` répond au lieu de prétendre l\'interface inconnue', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl status lo');
    expect(out).not.toContain('Cannot find device');
    expect(out).toContain('127.0.0.1/8');
    expect(out).toContain('::1/128');
  }, LONG);
});

describe('Scénario 3 — le verbe par défaut est `list`', () => {
  it('`networkctl` seul liste, il ne détaille pas', async () => {
    const { pc } = await lab();
    const nu = await pc.executeCommand('networkctl');
    expect(nu).toContain('IDX LINK');
    expect(nu, 'un bloc `status` commencerait par une puce').not.toContain('● ');
    expect(nu).toBe(await pc.executeCommand('networkctl list'));
  }, LONG);

  it('un verbe inconnu est refusé, avec un code de retour non nul', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('networkctl frobnicate'))
      .toContain("Unknown command verb 'frobnicate'.");
    expect(
      await pc.executeCommand('networkctl frobnicate; echo rc=$?'),
      'le code de retour doit se voir depuis le shell',
    ).toContain('rc=1');
  }, LONG);

  it('une interface inexistante est nommée dans l\'erreur', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('networkctl status nosuchif'))
      .toContain("Cannot find device 'nosuchif'.");
  }, LONG);
});

describe('Scénario 4 — `status` décrit le gestionnaire, `-a` décrit les liens', () => {
  it('sans cible, la sortie est globale et non un bloc par lien', async () => {
    const { pc } = await lab();
    const global = await pc.executeCommand('networkctl status');

    expect(global).toContain('State:');
    expect(global).toContain('Online state:');
    expect(
      (global.match(/●/g) ?? []).length,
      'une seule puce : c\'est l\'état du gestionnaire',
    ).toBe(1);
  }, LONG);

  it('`-a` rend bien un bloc par lien', async () => {
    const { pc } = await lab();
    const tous = await pc.executeCommand('networkctl status -a');
    expect((tous.match(/●/g) ?? []).length).toBeGreaterThan(1);
    expect(tous).toContain('lo');
    expect(tous).toContain('eth0');
  }, LONG);

  it('le bloc d\'un lien montre l\'état que l\'équipement porte déjà', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl status eth0');

    expect(out, 'la MAC est sur le Port, il n\'y avait qu\'à la lire').toMatch(/Hardware Address: \S+/);
    expect(out).toMatch(/MTU: 1500/);
    expect(out).toContain('10.0.0.5/24');
    expect(out).toMatch(/State: routable/);
  }, LONG);

  it('l\'adresse IPv6 est rendue sans son identifiant de zone', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl status eth0');
    expect(out, 'la zone appartient au socket, pas à l\'adresse').not.toContain('%eth0');
  }, LONG);
});

describe('Scénario 5 — la source d\'adresse est constatée, pas déclarée', () => {
  it('une IP posée à la main est statique, quoi qu\'annonce le netplan DHCP', async () => {
    const { pc } = await lab();
    // `sudo` volontairement : un fichier netplan est en 0600 chez Ubuntu,
    // et le simulateur applique la permission pour de bon.
    const netplan = await pc.executeCommand('sudo cat /etc/netplan/01-netcfg.yaml');
    expect(netplan, 'la déclaration dit bien DHCP — c\'est la prémisse du test').toContain('dhcp4: true');

    expect(
      await pc.executeCommand('networkctl status eth0'),
      'lire le fichier déclaré au lieu du lien était le défaut',
    ).toMatch(/Address Source: static/);
  }, LONG);

  it('une interface déclarée en DHCP sans bail reste `configuring`', async () => {
    const { pc } = await lab();
    const eth1 = listRows(await pc.executeCommand('networkctl list')).find((l) => l.LINK === 'eth1');
    expect(
      eth1!.SETUP,
      'networkd n\'a pas fini tant que le bail n\'est pas obtenu',
    ).toBe('configuring');
  }, LONG);
});

describe('Scénario 6 — les options ne sont plus jetées', () => {
  it('`--version` rend une version, pas la liste des liens', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl --version');
    expect(out).toMatch(/^systemd \d+/);
    expect(out).not.toContain('IDX LINK');
  }, LONG);

  it('`--no-legend` retire l\'en-tête et le pied', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl --no-legend list');
    expect(out).not.toContain('IDX LINK');
    expect(out).not.toContain('links listed');
    expect(out, 'les lignes de données restent').toContain('eth0');
  }, LONG);

  it('`--help` décrit les verbes disponibles', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('networkctl --help');
    for (const verbe of ['list', 'status', 'lldp', 'up', 'down', 'renew', 'reload']) {
      expect(out, `${verbe} doit figurer dans l'aide`).toContain(verbe);
    }
  }, LONG);

  it('un motif filtre la liste, littéral ou glob', async () => {
    const { pc } = await lab();
    const un = listRows(await pc.executeCommand('networkctl list eth0'));
    expect(un.map((l) => l.LINK)).toEqual(['eth0']);

    const glob = listRows(await pc.executeCommand('networkctl list eth*'));
    expect(glob.map((l) => l.LINK)).not.toContain('lo');
    expect(glob.length).toBeGreaterThan(1);
  }, LONG);
});
