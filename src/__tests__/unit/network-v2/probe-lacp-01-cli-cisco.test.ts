/**
 * Probes — LACP sur la CLI Cisco.
 *
 * Même forme que le 802.1X : `LacpAgent` fait tourner une vraie machine
 * de réception 802.3ad, et `setSystemPriority` / `setFastRate` — qui
 * déplacent réellement la cadence d'annonce, le `current_while` et le
 * départage d'agrégation — n'étaient appelés de nulle part.
 * `show etherchannel` était la seule fenêtre sur tout cela.
 *
 * Ce qui n'est adossé à rien est refusé en nommant la raison, plutôt
 * que stocké pour faire joli.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function conf(sw: CiscoSwitch, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await sw.executeCommand(l));
  return out;
}

/** Deux switchs, deux liens agrégés en Port-channel 1. */
async function bundle(): Promise<{ sw1: CiscoSwitch; sw2: CiscoSwitch; c1: Cable }> {
  const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
  const c1 = new Cable('a');
  c1.connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
  new Cable('b').connect(sw1.getPort('FastEthernet0/2')!, sw2.getPort('FastEthernet0/2')!);
  for (const s of [sw1, sw2]) {
    await conf(s, ['enable', 'configure terminal',
      'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'end']);
  }
  return { sw1, sw2, c1 };
}

describe('Scénario 1 — les réglages atteignent enfin le moteur', () => {
  it('`lacp system-priority` change la priorité annoncée', async () => {
    const { sw1 } = await bundle();
    expect(await sw1.executeCommand('show lacp sys-id')).toMatch(/^32768, /);

    await conf(sw1, ['configure terminal', 'lacp system-priority 100', 'end']);

    expect(await sw1.executeCommand('show lacp sys-id')).toMatch(/^100, /);
    expect(sw1.getLacpAgent().getConfig().systemPriority).toBe(100);
  });

  it('`lacp rate fast` bascule la cadence, et cela se voit dans les drapeaux', async () => {
    const { sw1 } = await bundle();
    expect(await sw1.executeCommand('show lacp internal')).toMatch(/Fa0\/1\s+SA/);

    await conf(sw1, ['configure terminal', 'interface FastEthernet0/1', 'lacp rate fast', 'end']);

    expect(sw1.getLacpAgent().getConfig().fastRate).toBe(true);
    expect(await sw1.executeCommand('show lacp internal')).toMatch(/Fa0\/1\s+FA/);
  });

  it('`lacp port-priority` ne touche que son port, et voyage dans la LACPDU', async () => {
    const { sw1 } = await bundle();
    await conf(sw1, ['configure terminal', 'interface FastEthernet0/1',
      'lacp port-priority 200', 'end']);

    const out = await sw1.executeCommand('show lacp internal');
    expect(out).toMatch(/Fa0\/1\s+\S+\s+\S+\s+200/);
    expect(out).toMatch(/Fa0\/2\s+\S+\s+\S+\s+32768/);
    expect(sw1.getLacpAgent().getPortInfo('FastEthernet0/1')?.portPriority).toBe(200);
  });

  it('une valeur hors bornes est refusée', async () => {
    const { sw1 } = await bundle();
    const [, out] = await conf(sw1, ['configure terminal', 'lacp system-priority 70000']);
    expect(out).toContain('valid range is 1 to 65535');
    expect(sw1.getLacpAgent().getConfig().systemPriority).toBe(32768);
  });
});

describe('Scénario 2 — les vues sur des données qui existaient déjà', () => {
  it('`show lacp neighbor` montre le partenaire réellement appris', async () => {
    const { sw1, sw2 } = await bundle();
    const out = await sw1.executeCommand('show lacp neighbor');
    // L'identité annoncée est bien celle du voisin, pas la sienne.
    expect(out).toContain(sw2.getLacpAgent().getConfig().systemId);
    expect(out).not.toMatch(new RegExp(`Partner System ID.*\\n.*${sw1.getLacpAgent().getConfig().systemId}`));
  });

  it('`show lacp counters` rend les compteurs réels de l\'agent', async () => {
    const { sw1 } = await bundle();
    const out = await sw1.executeCommand('show lacp counters');
    const stats = sw1.getLacpAgent().getStatistics('FastEthernet0/1');
    expect(stats.sent).toBeGreaterThan(0);
    expect(out).toMatch(new RegExp(`Fa0/1\\s+${stats.sent}\\s+${stats.received}`));
  });

  it('`show lacp sys-id` rend priorité et identité, dans cet ordre', async () => {
    const { sw1 } = await bundle();
    const out = (await sw1.executeCommand('show lacp sys-id')).trim();
    expect(out).toBe(`32768, ${sw1.getLacpAgent().getConfig().systemId}`);
  });

  it('un sous-verbe inconnu reste une erreur de syntaxe IOS', async () => {
    const { sw1 } = await bundle();
    expect(await sw1.executeCommand('show lacp bidon')).toContain('% Invalid input');
  });

  it('`show interfaces <if> etherchannel` donne la vue par port', async () => {
    const { sw1, sw2 } = await bundle();
    const out = await sw1.executeCommand('show interfaces FastEthernet0/1 etherchannel');
    expect(out).toContain('Channel group = 1');
    expect(out).toContain('In-Bndl');
    expect(out).toContain(sw2.getLacpAgent().getConfig().systemId);
  });

  it('un port hors faisceau le dit, plutôt que de rendre une vue vide', async () => {
    const { sw1 } = await bundle();
    expect(await sw1.executeCommand('show interfaces FastEthernet0/6 etherchannel'))
      .toContain('not part of an EtherChannel');
  });
});

describe('Scénario 3 — ce qui n\'est adossé à rien est refusé', () => {
  it('PAgP est nommé plutôt que converti en LACP', async () => {
    const { sw1 } = await bundle();
    const [, , out] = await conf(sw1, ['configure terminal', 'interface FastEthernet0/3',
      'channel-group 2 mode desirable']);
    // Demander PAgP et émettre du LACP était un mensonge invisible.
    expect(out).toContain('PAgP');
    expect(out).toContain('not implemented');
    expect(sw1.getLacpAgent().getPortInfo('FastEthernet0/3')).toBeUndefined();
  });

  it('`show pagp` le dit aussi', async () => {
    const { sw1 } = await bundle();
    expect(await sw1.executeCommand('show pagp neighbor')).toContain('PAgP is not implemented');
  });

  it('la répartition de charge est acceptée, et rendue par sa vue', async () => {
    const { sw1 } = await bundle();
    const [, out] = await conf(sw1, ['configure terminal', 'port-channel load-balance src-dst-ip']);
    expect(out).toBe('');
    await sw1.executeCommand('end');
    expect(await sw1.executeCommand('show etherchannel load-balance')).toContain('src-dst-ip');
  });

  it('une méthode de répartition inventée est refusée', async () => {
    const { sw1 } = await bundle();
    const [, out] = await conf(sw1, ['configure terminal', 'port-channel load-balance zorglub']);
    expect(out).toContain('Invalid input');
  });

  it('les modes LACP réels restent acceptés', async () => {
    const { sw1 } = await bundle();
    const [, , out] = await conf(sw1, ['configure terminal', 'interface FastEthernet0/4',
      'channel-group 3 mode passive']);
    expect(out).toBe('');
    expect(sw1.getLacpAgent().getPortInfo('FastEthernet0/4')?.mode).toBe('passive');
  });
});

describe('Scénario 4 — un membre dont le pair se tait quitte l\'agrégat', () => {
  it('le port du voisin désactivé sort le membre du faisceau', async () => {
    const { sw1, sw2 } = await bundle();
    expect(await sw1.executeCommand('show etherchannel summary')).toMatch(/Fa0\/1\(P\)/);

    await conf(sw2, ['configure terminal', 'interface FastEthernet0/1', 'shutdown', 'end']);

    // La sélection testait « un câble est branché » ; un membre dont le
    // pair n'émet plus ne porte pourtant plus rien.
    expect(sw1.getLacpAgent().getPortInfo('FastEthernet0/1')?.bundled).toBe(false);
    expect(await sw1.executeCommand('show etherchannel summary')).not.toMatch(/Fa0\/1\(P\)/);
  });

  it('le voisin hors tension a le même effet', async () => {
    const { sw1, sw2 } = await bundle();
    sw2.powerOff();
    expect(sw1.getLacpAgent().getPortInfo('FastEthernet0/1')?.bundled).toBe(false);
    expect(sw1.getLacpAgent().getPortInfo('FastEthernet0/2')?.bundled).toBe(false);
  });
});
