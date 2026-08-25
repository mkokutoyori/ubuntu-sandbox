/**
 * Une vue MIB decide ce qu'une communaute peut LIRE.
 *
 * Mesure de depart : `snmp-agent mib-view` etait range dans
 * `SnmpService.recordVrpLine` — un sac de chaines brutes que seul le
 * rendu de la configuration relit — et `snmp-agent community read X
 * mib-view Y` gardait le nom de la vue sans que rien ne le lise. Une
 * communaute restreinte a une vue VIDE lisait donc `sysName` comme
 * n'importe quelle autre : le mecanisme entier etait un decor.
 *
 * Le magasin, lui, EXISTAIT DEJA : `SnmpService.views` est alimente par
 * `snmp-server view` cote Cisco depuis toujours, et une communaute
 * portait deja son `view`. Il manquait la porte VRP, la projection vers
 * l'agent, et l'evaluation — le « moteur sans porte » que ce depot
 * referme regulierement.
 *
 * La regle est celle de la RFC 3415 (VACM), verifiee sur l'implantation
 * de net-snmp (`snmplib/vacm.c`, `netsnmp_view_get`) plutot que de
 * memoire : parmi les entrees de la vue dont le sous-arbre PREFIXE
 * l'OID, la plus LONGUE l'emporte ; a longueur egale, la plus grande
 * lexicographiquement ; aucune entree ne prefixe l'OID, il est hors de
 * la vue. La documentation Huawei dit la meme chose dans ses mots :
 * « whether to include or exclude the lowest MIB object will be
 * determined by the parameter configured for the lowest MIB object ».
 *
 * Trouve en chemin : rejouer la commande sur le MEME sous-arbre doit
 * REMPLACER l'entree, ce que Huawei documente ; `configView` empilait
 * les doublons, que la regle du plus long sous-arbre departageait
 * ensuite par hasard.
 *
 * Discrimination par `git stash` : 7 des 9 cas tombent. Les deux autres
 * sont nommes — « TEMOIN, une communaute sans vue voit tout », c'est le
 * defaut et il ne devait pas bouger ; et la sonde unitaire de la regle
 * VACM, dont le module est nouveau et purement additif.
 *
 * Un piege rencontre en ecrivant cette sonde et corrige plutot que
 * laisse : le cas de l'exclusion visait d'abord `ifInOctets`, un OID que
 * cet agent ne sert PAS — il rendait donc `no-such-object` avec ou sans
 * vue, et le cas passait des deux cotes sans rien prouver. Il vise
 * desormais `ifDescr`, que l'agent sert vraiment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { OID_SYS_NAME } from '@/network/snmp/types';
import { oidInMibView } from '@/network/snmp/mibView';

const OID_IF_DESCR_1 = '1.3.6.1.2.1.2.2.1.2.1';
const OID_IF_INDEX_1 = '1.3.6.1.2.1.2.2.1.1.1';

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

async function lit(b: Banc, communaute: string, oid: string): Promise<string | null> {
  let repondu: string | null = null;
  void b.nms.getSnmpAgent().get('10.0.0.1', communaute, [oid])
    .then((vbs) => {
      if (vbs === null) return;
      repondu = vbs[0].value.type === 'no-such-object' ? null : String(vbs[0].value.value);
    });
  await new Promise((res) => setTimeout(res, 30));
  return repondu;
}

describe('une vue MIB filtre vraiment', () => {
  beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

  it('TEMOIN, une communaute sans vue voit tout', async () => {
    const b = await banc(['snmp-agent community read total']);
    expect(await lit(b, 'total', OID_SYS_NAME)).toBe('R1');
    expect(await lit(b, 'total', OID_IF_DESCR_1)).not.toBeNull();
  });

  it('une communaute restreinte ne lit pas hors de sa vue', async () => {
    const b = await banc([
      'snmp-agent mib-view included restreint interfaces',
      'snmp-agent community read limite mib-view restreint',
    ]);
    expect(await lit(b, 'limite', OID_IF_DESCR_1)).not.toBeNull();
    expect(await lit(b, 'limite', OID_SYS_NAME)).toBeNull();
  });

  it('une exclusion posee plus profond l emporte sur l inclusion', async () => {
    const b = await banc([
      'snmp-agent mib-view included restreint interfaces',
      'snmp-agent mib-view excluded restreint 1.3.6.1.2.1.2.2.1.2',
      'snmp-agent community read limite mib-view restreint',
    ]);
    expect(await lit(b, 'limite', OID_IF_INDEX_1)).not.toBeNull();
    expect(await lit(b, 'limite', OID_IF_DESCR_1)).toBeNull();
  });

  it('nommer une vue qui n existe pas ne laisse rien passer', async () => {
    const b = await banc(['snmp-agent community read limite mib-view absente']);
    expect(await lit(b, 'limite', OID_SYS_NAME)).toBeNull();
  });

  it('la forme `<vue> include <sous-arbre>` est acceptee elle aussi', async () => {
    const b = await banc([
      'snmp-agent mib-view restreint include system',
      'snmp-agent community read limite mib-view restreint',
    ]);
    expect(await lit(b, 'limite', OID_SYS_NAME)).toBe('R1');
    expect(await lit(b, 'limite', OID_IF_DESCR_1)).toBeNull();
  });

  it('rejouer la commande sur le meme sous-arbre remplace l entree', async () => {
    const b = await banc([
      'snmp-agent mib-view included restreint system',
      'snmp-agent mib-view excluded restreint system',
      'snmp-agent community read limite mib-view restreint',
    ]);
    expect(await lit(b, 'limite', OID_SYS_NAME)).toBeNull();
    const vues = b.r.getSnmpService().getViews().get('restreint');
    expect(vues?.length).toBe(1);
  });

  it('un sous-arbre qui n est ni un OID ni un nom connu est refuse', async () => {
    const b = await banc();
    expect(await b.r.executeCommand('snmp-agent mib-view included v zorglub'))
      .toContain('Error:');
    expect(await b.r.executeCommand('snmp-agent mib-view included v')).toContain('Error:');
  });

  it('la configuration rendue reproduit les vues', async () => {
    const b = await banc([
      'snmp-agent mib-view included restreint interfaces',
      'snmp-agent mib-view excluded restreint 1.3.6.1.2.1.2.2.1.2',
      'snmp-agent community read limite mib-view restreint',
    ]);
    const cfg = await b.r.executeCommand('display current-configuration');
    expect(cfg).toContain('snmp-agent mib-view included restreint 1.3.6.1.2.1.2');
    expect(cfg).toContain('snmp-agent mib-view excluded restreint 1.3.6.1.2.1.2.2.1.2');
    expect(cfg).toContain('snmp-agent community read limite mib-view restreint');
  });

  it('la regle VACM : le sous-arbre le plus long tranche', () => {
    const vue = [
      { oid: '1.3.6.1.2.1', type: 'included' as const },
      { oid: '1.3.6.1.2.1.2', type: 'excluded' as const },
      { oid: '1.3.6.1.2.1.2.2.1.2', type: 'included' as const },
    ];
    expect(oidInMibView('1.3.6.1.2.1.1.5.0', vue)).toBe(true);
    expect(oidInMibView('1.3.6.1.2.1.2.2.1.10.1', vue)).toBe(false);
    expect(oidInMibView('1.3.6.1.2.1.2.2.1.2.1', vue)).toBe(true);
    expect(oidInMibView('1.3.6.1.4.1.9', vue)).toBe(false);
    expect(oidInMibView('1.3.6.1.2.1.1.5.0', [])).toBe(false);
  });
});
