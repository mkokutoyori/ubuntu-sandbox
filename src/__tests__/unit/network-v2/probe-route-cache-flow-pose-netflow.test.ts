/**
 * `ip route-cache flow' pose sur une interface ne posait RIEN.
 *
 * MESURE DE DEPART sur `a64ea58c', sur un CiscoRouter, interface
 * GigabitEthernet0/1 :
 *
 *   R(config-if)# ip route-cache flow        -> acceptee, sans un mot
 *   service NetFlow, ifaceModes              -> []
 *   show running-config | section Gi0/1      -> pas de `ip flow ingress'
 *
 *   R(config-if)# ip flow ingress            -> acceptee
 *   service NetFlow, ifaceModes              -> [["GigabitEthernet0/1",
 *                                                {ingress:true,egress:false}]]
 *   show running-config | section Gi0/1      ->  ip flow ingress
 *
 * Les deux frappes nomment la MEME chose — `ip route-cache flow' est
 * l'orthographe heritee de `ip flow ingress' sur une interface — et la
 * machine en honorait une sur deux, en silence. C'est la forme que la
 * regle 6 nomme : un critere accepte, sans effet, et sans refus.
 *
 * POURQUOI, mesure et non devinee. La commande etait declaree DEUX fois :
 *
 *   - sur le trie des commandes d'interface, avec le bon gestionnaire
 *     (`setLegacyInterfaceMode(i, 'ingress', true)') ;
 *   - sur le socle, `modes: ['config']', avec un gestionnaire qui rend ''
 *     et ne pose rien.
 *
 * Et c'est la copie VIDE qui gagnait. `CiscoShellBase.tryMigratedCommand'
 * ne cede au trie, pour une declaration hors mode, que si le trie resout
 * la ligne exactement :
 *
 *   if (!parsed.spec.modes.includes(this.mode)
 *       && this.getActiveTrie().match(cmdPart).status === 'ok') return null;
 *
 * Or `getActiveTrie().match('ip route-cache flow')' rend `invalid' en
 * `config-if' — mesure. Le garde ne joue donc pas, et le socle execute sa
 * declaration `config' depuis le sous-mode, par l'HERITAGE que
 * `confinerSousVue' documente quelques lignes plus bas. C'est le troisieme
 * des quatre pieges que CLAUDE.md nomme autour du socle, pris sur le fait.
 *
 * Les deux ecritures d'un meme fait partent donc a UNE : la declaration du
 * socle porte les deux modes et fait, sur une interface, ce que le trie
 * faisait ; la declaration du trie disparait.
 *
 * En configuration GLOBALE, `ip route-cache flow' active NetFlow sur
 * TOUTES les interfaces d'un vrai routeur. Ici elle reste acceptee sans
 * rien poser, et c'est une limite assumee, pas un oubli : un import de
 * configuration la porte, et la refuser ferait perdre une ligne que le
 * vrai equipement garde.
 *
 * MESURE : 3 cas tombent sur 6. Les trois qui passent des deux cotes :
 *   - TEMOIN : `ip flow ingress' posait deja, et pose toujours — sans lui
 *     une sonde faite de refus ne prouverait pas que le lab serialise ;
 *   - NON-REGRESSION : `ip flow egress' reste distinct de l'ingress ;
 *   - NON-REGRESSION : la forme globale reste acceptee sans broncher.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const IFACE = 'GigabitEthernet0/1';

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R', 0, 0);
  for (const c of [
    'enable', 'configure terminal', `interface ${IFACE}`,
    'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'end',
  ]) await r.executeCommand(c);
  return r;
}

async function surIface(r: CiscoRouter, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['configure terminal', `interface ${IFACE}`, ...cmds, 'end']) {
    last = String(await r.executeCommand(c));
  }
  return last;
}

const section = (r: CiscoRouter): Promise<string> =>
  r.executeCommand(`show running-config | section ${IFACE}`).then(String);

describe('`ip route-cache flow` est l orthographe heritee de `ip flow ingress`', () => {
  it('TEMOIN : `ip flow ingress` se serialise', async () => {
    const r = await routeur();
    await surIface(r, 'ip flow ingress');
    expect(await section(r)).toContain('ip flow ingress');
  });

  it('`ip route-cache flow` se serialise en `ip flow ingress`', async () => {
    const r = await routeur();
    await surIface(r, 'ip route-cache flow');
    expect(await section(r)).toContain('ip flow ingress');
  });

  it('`ip route-cache flow` n est pas avalee en silence', async () => {
    const r = await routeur();
    await surIface(r, 'ip route-cache flow');
    const modes = (r as unknown as {
      getNetflowService: () => { getLegacy: () => { ifaceModes: Map<string, { ingress: boolean }> } };
    }).getNetflowService().getLegacy().ifaceModes;
    expect(modes.get(IFACE)?.ingress).toBe(true);
  });

  it('les deux orthographes posent le MEME etat', async () => {
    const a = await routeur();
    await surIface(a, 'ip route-cache flow');
    const b = await routeur();
    await surIface(b, 'ip flow ingress');
    expect(await section(a)).toBe(await section(b));
  });

  it('NON-REGRESSION : `ip flow egress` reste distinct', async () => {
    const r = await routeur();
    await surIface(r, 'ip flow egress');
    const cfg = await section(r);
    expect(cfg).toContain('ip flow egress');
    expect(cfg).not.toContain('ip flow ingress');
  });

  it('NON-REGRESSION : la forme globale reste acceptee sans rien poser', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    const out = String(await r.executeCommand('ip route-cache flow'));
    await r.executeCommand('end');
    expect(out).not.toMatch(/Invalid input|Incomplete/);
    expect(await section(r)).not.toContain('ip flow ingress');
  });
});
