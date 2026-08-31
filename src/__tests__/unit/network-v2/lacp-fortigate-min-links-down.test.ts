/**
 * `min-links-down` decide CE QUE devient une agregation FortiGate
 * lorsque le nombre de membres actifs passe sous `min-links`. Le
 * schema d'API de FortiOS le decrit ainsi — « Action to take when less
 * than the configured minimum number of links are active », choix
 * `operational` ou `administrative` — et la note technique de Fortinet
 * ajoute les deux moities qui manquent : le port est descendu
 * OPERATIONNELLEMENT par defaut, et sous `administrative` « the LAG
 * will be set administratively DOWN ».
 *
 * LE DEFAUT MESURE : l'attribut etait refuse (`unknown attribute
 * "min-links-down"`) et le comportement CABLE etait celui qu'il ne
 * choisit pas. `refreshAggregates` appelait `interfaces.setUp`, qui
 * projette `setAdminShutdown` : une panne de cablage descendait donc
 * l'agregation ADMINISTRATIVEMENT, la journalisait « admin disabled »
 * — un evenement que personne n'a provoque — la ou le defaut de FortiOS
 * est de ne toucher qu'a la ligne.
 *
 * Trouve en chemin : `refreshAggregates` REMONTAIT l'interface des que
 * les liens suffisaient, donc un `set status down` tape par
 * l'operateur sur une agregation saine etait annule en silence par le
 * commit suivant.
 *
 * DISCRIMINATION : 6 des 10 cas tombent contre l'etat d'avant. Les 4
 * autres sont nommes : sous `administrative` l'agregation descend
 * administrativement, ce qui etait DEJA le cas puisque TOUT l'etait ;
 * « l'agregation est hors service dans les deux regimes », le TEMOIN,
 * dont c'est l'objet de passer des deux cotes ; le retour des liens,
 * qui remontait deja ; et « le defaut n'est pas rendu », qui passait
 * pour une raison qui ne prouve rien, l'attribut n'existant pas.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

async function labo(extra: readonly string[] = []) {
  const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  fw.powerOn(); sw.powerOn();
  const ports = fw.getPorts().map(p => p.getName());
  const cables: Cable[] = [];
  for (let i = 0; i < 2; i++) {
    const c = new Cable(`c${i}`);
    c.connect(fw.getPort(ports[2 + i])!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    cables.push(c);
  }
  await taper(sw, ['enable', 'configure terminal',
    'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'end']);
  await taper(fw, ['config system interface', 'edit bond1', 'set type aggregate',
    `set member ${ports[2]} ${ports[3]}`, 'set lacp-mode active', 'set min-links 2',
    ...extra,
    'set ip 10.0.0.1 255.255.255.0', 'next', 'end']);
  await vi.advanceTimersByTimeAsync(PERIODIC_MS);
  return { fw, sw, ports, cables };
}

describe('`min-links-down` choisit comment l\'agregation descend', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('`operational` est accepte', async () => {
    const { fw } = await labo();
    await taper(fw, ['config system interface', 'edit bond1']);
    expect(await fw.executeCommand('set min-links-down operational')).toBe('');
  }, 30_000);

  it('`administrative` est accepte', async () => {
    const { fw } = await labo(['set min-links-down administrative']);
    expect(await fw.executeCommand('show system interface bond1'))
      .toContain('set min-links-down administrative');
  }, 30_000);

  it('une valeur inconnue est refusee en nommant les valeurs admises', async () => {
    const { fw } = await labo();
    await taper(fw, ['config system interface', 'edit bond1']);
    expect(await fw.executeCommand('set min-links-down zorglub'))
      .toContain('allowed values: operational, administrative');
  }, 30_000);

  it('le defaut n\'est pas rendu, `operational` etant le defaut', async () => {
    const { fw } = await labo();
    expect(await fw.executeCommand('show system interface bond1'))
      .not.toContain('min-links-down');
  }, 30_000);

  it('`get system interface` rend l\'attribut', async () => {
    const { fw } = await labo(['set min-links-down administrative']);
    expect(await fw.executeCommand('get system interface bond1'))
      .toMatch(/min-links-down\s+: administrative/);
  }, 30_000);

  it('par defaut la panne descend la LIGNE et non l\'administration', async () => {
    const { fw, cables } = await labo();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(PERIODIC_MS * 3);
    expect(fw.getPort('bond1')?.isOperationallyUp()).toBe(false);
    expect(fw.getPort('bond1')?.isAdminDown()).toBe(false);
  }, 30_000);

  it('sous `administrative` la panne descend l\'administration', async () => {
    const { fw, cables } = await labo(['set min-links-down administrative']);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(PERIODIC_MS * 3);
    expect(fw.getPort('bond1')?.isAdminDown()).toBe(true);
  }, 30_000);

  it('TEMOIN : l\'agregation est hors service dans les deux regimes', async () => {
    for (const regime of ['operational', 'administrative']) {
      resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
      const { fw, cables } = await labo([`set min-links-down ${regime}`]);
      cables[0].disconnect();
      await vi.advanceTimersByTimeAsync(PERIODIC_MS * 3);
      expect(fw.getPort('bond1')?.isOperationallyUp()).toBe(false);
    }
  }, 30_000);

  it('les liens revenus, l\'agregation remonte', async () => {
    const { fw, sw, ports, cables } = await labo();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(PERIODIC_MS * 3);
    cables[0].connect(fw.getPort(ports[2])!, sw.getPort('FastEthernet0/1')!);
    await vi.advanceTimersByTimeAsync(PERIODIC_MS * 3);
    expect(fw.getPort('bond1')?.isOperationallyUp()).toBe(true);
    expect(fw.getPort('bond1')?.isAdminDown()).toBe(false);
  }, 30_000);

  it('un `set status down` de l\'operateur n\'est pas annule', async () => {
    const { fw } = await labo();
    await taper(fw, ['config system interface', 'edit bond1', 'set status down', 'next', 'end']);
    await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    expect(fw.getPort('bond1')?.isAdminDown()).toBe(true);
  }, 30_000);
});
