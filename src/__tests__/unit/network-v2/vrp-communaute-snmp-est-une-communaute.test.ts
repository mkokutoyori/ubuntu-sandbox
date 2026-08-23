/**
 * VRP — une communaute SNMP configuree est une communaute.
 *
 * Discrimination par `git stash` : 17 des 19 cas tombent avant
 * correctif. Les deux autres sont nommes plutot que laisses a
 * decouvrir. Le TEMOIN passe des deux cotes, et c'est son objet : il
 * verifie que la requete traverse le fil, sans quoi un banc mal monte
 * et une communaute refusee seraient indiscernables. « Reproduit ce
 * qui a ete tape » passe des deux cotes parce que l'ancien sac de
 * chaines brutes recopiait la saisie telle quelle — il garde le rendu,
 * il ne prouve pas le magasin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { OID_SYS_NAME } from '@/network/snmp/types';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

interface Banc { r: HuaweiRouter; nms: CiscoRouter }

async function banc(commandes: readonly string[] = []): Promise<Banc> {
  const bus = new EventBus();
  const r = new HuaweiRouter('R1');
  const nms = new CiscoRouter('NMS');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  r.setEventBus(bus); nms.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(r.getPorts()[0], sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(nms.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  r.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  nms.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  r.powerOn();
  await r.executeCommand('system-view');
  for (const c of commandes) await r.executeCommand(c);
  return { r, nms };
}

async function refusEntendu(b: Banc, communaute: string): Promise<string[]> {
  const raisons: string[] = [];
  b.r.getBus().subscribe('snmp.auth.rejected', (e) => raisons.push(e.payload.reason));
  await interroge(b, communaute);
  return raisons;
}

async function interroge(b: Banc, communaute: string): Promise<string | null> {
  let repondu: string | null = null;
  void b.nms.getSnmpAgent().get('10.0.0.1', communaute, [OID_SYS_NAME])
    .then((vbs) => { repondu = vbs === null ? null : String(vbs[0].value.value); });
  await new Promise((res) => setTimeout(res, 30));
  return repondu;
}

async function routeur(commandes: readonly string[] = []): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('R1');
  r.powerOn();
  await r.executeCommand('system-view');
  for (const c of commandes) await r.executeCommand(c);
  return r;
}

const configuration = async (r: HuaweiRouter | HuaweiSwitch): Promise<string[]> =>
  (await r.executeCommand('display current-configuration')).split('\n').map((l) => l.trim());

describe('VRP : une communaute SNMP configurée est une communauté', () => {
  it('TEMOIN — la requete traverse vraiment le fil', async () => {
    const b = await banc(['snmp-agent community read monSecret']);

    expect(await refusEntendu(b, 'inexistante')).toEqual(['unknown-community']);
  });

  it('la communauté configurée répond sur le fil', async () => {
    const b = await banc(['snmp-agent community write pilotage']);

    expect(await interroge(b, 'pilotage')).toBe('R1');
  });

  it('`public`, que personne n\'a configuré, ne répond pas', async () => {
    const b = await banc(['snmp-agent community read monSecret']);

    expect(await interroge(b, 'public')).toBeNull();
  });

  it('sur une machine sans configuration SNMP, aucune communauté ne répond', async () => {
    const b = await banc();

    expect(await interroge(b, 'public')).toBeNull();
  });

  it('`undo snmp-agent community` retire vraiment la communauté', async () => {
    const b = await banc(['snmp-agent community read monSecret']);
    expect(await interroge(b, 'monSecret')).toBe('R1');

    await b.r.executeCommand('undo snmp-agent community read monSecret');

    expect(await interroge(b, 'monSecret')).toBeNull();
  });

  it('`acl` filtre la source pour de bon, et le dit', async () => {
    const b = await banc([
      'acl number 2000',
      'rule 5 permit source 10.0.0.9 0',
      'quit',
      'snmp-agent community read restreinte acl 2000',
    ]);

    expect(await refusEntendu(b, 'restreinte')).toEqual(['acl-denied']);
  });

  it('`acl` laisse passer la source permise', async () => {
    const b = await banc([
      'acl number 2000',
      'rule 5 permit source 10.0.0.2 0',
      'quit',
      'snmp-agent community read restreinte acl 2000',
    ]);

    expect(await interroge(b, 'restreinte')).toBe('R1');
  });
});

describe('VRP : la grammaire de `snmp-agent` refuse ce que VRP refuse', () => {
  it('sans nom de communauté, la commande est incomplète', async () => {
    const r = await routeur();

    expect(await r.executeCommand('snmp-agent community read')).toContain('Incomplete command');
  });

  it('sans droit d\'accès, la commande est incomplète', async () => {
    const r = await routeur();

    expect(await r.executeCommand('snmp-agent community')).toContain('Incomplete command');
  });

  it('un droit d\'accès inconnu est refusé', async () => {
    const r = await routeur();

    expect(await r.executeCommand('snmp-agent community zorglub')).toContain('Wrong parameter');
  });

  it('un mot de trop après le nom est refusé', async () => {
    const r = await routeur();

    expect(await r.executeCommand('snmp-agent community read public zorglub'))
      .toContain('Wrong parameter');
  });

  it('une version SNMP inconnue est refusée', async () => {
    const r = await routeur();

    expect(await r.executeCommand('snmp-agent sys-info version zorglub'))
      .toContain('Wrong parameter');
  });

  it('un mot-clé que VRP ne connaît pas est refusé', async () => {
    const r = await routeur();

    expect(await r.executeCommand('snmp-agent zorglub')).toContain('Wrong parameter');
  });

  it('`trap enable` arme vraiment les notifications', async () => {
    const r = await routeur(['snmp-agent trap enable feature-name ospf']);

    expect(r.getSnmpService().isTrapEnabled('ospf')).toBe(true);
    expect(r.getSnmpService().isTrapEnabled('bgp')).toBe(false);
  });

  it('`trap source` et `protocol source-interface` ne sont pas la même commande', async () => {
    const r = await routeur([
      'snmp-agent trap source LoopBack0',
      'snmp-agent protocol source-interface LoopBack1',
    ]);

    expect(r.getSnmpService().getTrapSource()).toBe('LoopBack0');
    const rendu = await configuration(r);
    expect(rendu).toContain('snmp-agent trap source LoopBack0');
    expect(rendu).toContain('snmp-agent protocol source-interface LoopBack1');
  });

  it('`mib-view` est une vue, pas une liste de contrôle', async () => {
    const r = await routeur(['snmp-agent community read lecture mib-view maVue']);

    const c = r.getSnmpService().getCommunities()[0];
    expect(c.view).toBe('maVue');
    expect(c.aclName).toBeUndefined();
  });
});

describe('VRP : la configuration SNMP se relit', () => {
  it('reproduit ce qui a été tapé', async () => {
    const lignes = [
      'snmp-agent community read public',
      'snmp-agent community write private',
      'snmp-agent sys-info version v2c v3',
      'snmp-agent sys-info contact admin@lab',
      'snmp-agent sys-info location Salle-B',
    ];

    const rendu = await configuration(await routeur(lignes));

    for (const l of lignes) expect(rendu, l).toContain(l);
  });

  it('`display snmp-agent sys-info` répond ce qui a été tapé', async () => {
    const r = await routeur(['snmp-agent sys-info contact admin@lab']);

    expect(await r.executeCommand('display snmp-agent sys-info')).toContain('admin@lab');
  });

  it('le commutateur écrit dans son propre magasin et le rend', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1');
    sw.powerOn();
    await sw.executeCommand('system-view');
    await sw.executeCommand('snmp-agent community read supervision');

    expect(sw.getSnmpService().getCommunities().map((c) => c.name)).toEqual(['supervision']);
    expect(await configuration(sw)).toContain('snmp-agent community read supervision');
  });
});
