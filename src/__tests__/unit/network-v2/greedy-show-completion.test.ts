import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Greedy-command continuation completion — Cisco switch show family', () => {
  let sw: CiscoSwitch;
  beforeEach(async () => {
    sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
  });

  it('show interfaces status completes (the reported bug)', () => {
    expect(sw.cliTabCandidates('show interfaces stat')).toEqual(['show interfaces status']);
    expect(sw.cliTabComplete('show interfaces stat')).toBe('show interfaces status ');
  });

  it('show interfaces exposes all its sub-keywords in ? help and Tab', () => {
    const help = sw.cliHelp('show interfaces ');
    for (const kw of ['status', 'switchport', 'counters', 'description', 'trunk']) {
      expect(help).toContain(kw);
    }
    expect(sw.cliTabCandidates('show interfaces sw')).toEqual(['show interfaces switchport']);
    expect(sw.cliTabCandidates('show interfaces c')).toEqual(['show interfaces counters']);
    expect(sw.cliTabCandidates('show interfaces d')).toEqual(['show interfaces description']);
  });

  it('show mac address-table sub-keywords complete', () => {
    expect(sw.cliTabCandidates('show mac address-table dyn')).toEqual(['show mac address-table dynamic']);
    expect(sw.cliTabCandidates('show mac address-table stat')).toEqual(['show mac address-table static']);
    const help = sw.cliHelp('show mac address-table ');
    expect(help).toContain('vlan');
    expect(help).toContain('interface');
  });

  it('show etherchannel / port-security sub-keywords complete', () => {
    expect(sw.cliTabCandidates('show etherchannel sum')).toEqual(['show etherchannel summary']);
    expect(sw.cliTabCandidates('show port-security int')).toEqual(['show port-security interface']);
  });

  /*
   * `show access-lists interface` etait exige ici, et ce n'est pas une
   * forme de cette commande : son gestionnaire ne lit qu'UN argument et
   * le prend pour un NOM de liste. Le mot venait de la table de
   * completion de `show port-security`, qui l'honore vraiment ; recopie
   * sur la vue ACL, il y cherchait une liste nommee « interface » et
   * rendait une vue vide sans un mot.
   *
   * La place est un nom LIBRE : la tabulation n'a donc rien a y deviner,
   * et n'offre aucun candidat. C'est la reponse juste, et ce cas la
   * mesure a la place de l'ancienne.
   */
  it('`show access-lists int` n offre rien : la place est un nom libre', () => {
    expect(sw.cliTabCandidates('show access-lists int')).toEqual([]);
    expect(sw.cliHelp('show access-lists ')).not.toContain('interface');
  });

  it('the continuation keywords still EXECUTE (completion did not break the handler)', async () => {
    const out = await sw.executeCommand('show interfaces status');
    expect(out.toLowerCase()).toMatch(/port|status|name/);
  });
});

describe('Greedy-command continuation completion — Huawei switch display family', () => {
  let sw: HuaweiSwitch;
  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.executeCommand('system-view');
  });

  it('display interface brief completes', () => {
    expect(sw.cliTabCandidates('display interface br')).toEqual(['display interface brief']);
  });

  it('display vlan summary completes', () => {
    expect(sw.cliTabCandidates('display vlan sum')).toEqual(['display vlan summary']);
  });

  it('display interface brief still executes', async () => {
    const out = await sw.executeCommand('display interface brief');
    expect(out).not.toBe('');
  });
});
