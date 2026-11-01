/*
 * `?` et la tabulation d'un FortiGate doivent atteindre TOUT ce qu'on peut taper, pas seulement le
 * premier mot.
 *
 * Mesure de depart : `execute router ?` rendait `clear` et `restart`, puis `execute router clear ?`
 * ne rendait RIEN alors que `execute router clear bgp all`, `execute router clear ospf process`,
 * `execute clear system arp table`, `execute vpn certificate local generate rsa ...`,
 * `execute backup config tftp ...`, `execute dhcp lease-clear all` ou `execute ha synchronize
 * start` s'executent : le vocabulaire de `execute` ne decrivait qu'UN niveau
 * (`FortiExecuteOption` sans enfants), et les queues `REST` de `diagnose` (filtres de session et de
 * flux, `debug application <daemon> <niveau>`, `debug flow show function-name enable|disable`,
 * `debug console timestamp`, `auth filter`, `ike gateway clear name`) n'annoncaient qu'une
 * phrase generique (« Filter criterion. »).
 *
 * Correctif : le vocabulaire `execute` est un ARBRE (`options` imbriquees + `argument`), les feuilles
 * deviennent des commandes du socle (donc `?`, Tab et l'abreviation les connaissent), et les mots-cles
 * des filtres de `diagnose` viennent de `diag/diagVocabulary.ts`, dont `FortiDiagCommands` lit aussi la
 * liste pour son message d'erreur (une seule ecriture). Un noeud intermediaire (`execute clear
 * system`) repond « incomplete » au lieu de « unknown action ».
 *
 * Garde-fou (le livrable) : on parcourt `?` depuis `diagnose`, `execute`, `get` et `fnsysctl`, et
 * TOUT mot offert doit s'executer sans « Unknown action » ni « unknown command » ; un chemin
 * incomplet repond « command parse error ... missing ».
 *
 * Discrimine avec `git stash push -- src/network` : les cas de vocabulaire imbrique et de queues
 * tombent avant ; le parcours garde-fou et les TEMOINS (`execute router ?`, les mots de premier
 * niveau) passent des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function neuf(): FortiGate {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0);
}

const offered = (fw: FortiGate, line: string): string[] =>
  fw.getShell().help(line).map((row) => /^\s*(\S+)/.exec(row)?.[1] ?? '').filter((word) => word !== '' && word !== '<cr>');

describe('le vocabulaire imbrique de `execute`', () => {
  const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['execute router clear ', ['bgp', 'ospf']],
    ['execute router clear bgp ', ['all', 'as', 'external', 'ip']],
    ['execute router clear ospf ', ['process']],
    ['execute clear system ', ['arp']],
    ['execute clear system arp ', ['table']],
    ['execute vpn ', ['certificate', 'ipsec', 'sslvpn']],
    ['execute vpn certificate local ', ['export', 'generate', 'import']],
    ['execute vpn certificate local generate ', ['rsa']],
    ['execute vpn certificate ca ', ['export', 'import']],
    ['execute vpn ipsec tunnel ', ['down', 'up']],
    ['execute vpn sslvpn ', ['del-all', 'del-tunnel', 'del-web', 'list']],
    ['execute vpn sslvpn list ', ['tunnel', 'web']],
    ['execute backup ', ['config', 'full-config']],
    ['execute backup config ', ['tftp']],
    ['execute restore config ', ['flash', 'tftp']],
    ['execute revision ', ['delete', 'list']],
    ['execute revision list ', ['config']],
    ['execute dhcp lease-clear ', ['all']],
    ['execute ha ', ['disconnect', 'failover', 'manage', 'set-priority', 'synchronize']],
    ['execute ha failover ', ['set']],
    ['execute ha synchronize ', ['start', 'stop']],
    ['execute set system session ', ['filter']],
  ];
  for (const [line, words] of CASES) {
    it(`${line}? rend ${words.join(', ')}`, () => {
      expect(offered(neuf(), line).sort()).toEqual(expect.arrayContaining([...words]));
    });
  }

  it('la tabulation developpe un chemin imbrique et abrege', () => {
    const fw = neuf();
    expect(fw.cliTabCandidates('execute router clear b')).toEqual(['execute router clear bgp']);
    expect(fw.cliTabCandidates('execute vpn cert loc gen')).toEqual(['execute vpn certificate local generate']);
    expect(fw.cliTabCandidates('execute clear sys ar')).toEqual(['execute clear system arp']);
  });

  it('la description d\'un noeud intermediaire est la sienne, pas celle d\'une feuille', () => {
    const rows = neuf().getShell().help('execute router ');
    expect(rows.find((row) => row.startsWith('clear'))).toContain('Clear routing sessions.');
  });

  it('un chemin intermediaire est INCOMPLET, pas une action inconnue', async () => {
    const fw = neuf();
    expect(await fw.executeCommand('execute clear system')).toMatch(/missing/);
    expect(await fw.executeCommand('execute router clear')).toMatch(/missing/);
    expect(await fw.executeCommand('execute set system')).toMatch(/missing/);
  });

  it('une branche de `get` seule est INCOMPLETE, pas un chemin inconnu', async () => {
    const fw = neuf();
    for (const line of ['get system', 'get firewall', 'get router']) {
      expect(await fw.executeCommand(line)).toMatch(/missing/);
    }
  });

  it('TEMOIN : ce qui s\'executait s\'execute toujours', async () => {
    const fw = neuf();
    expect(await fw.executeCommand('execute clear system arp table')).toBe('');
  });
});

describe('les queues de `diagnose` annoncent leurs mots-cles', () => {
  const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['diagnose sys session filter ', ['clear', 'dport', 'dst', 'policy', 'proto', 'sport', 'src', 'vd']],
    ['diagnose sys session6 filter ', ['clear', 'dst', 'src']],
    ['diagnose debug flow filter ', ['addr', 'clear', 'daddr', 'dport', 'port', 'proto', 'saddr', 'sport', 'vd']],
    ['diagnose debug flow trace ', ['start', 'stop']],
    ['diagnose debug flow show ', ['console', 'function-name', 'iprope']],
    ['diagnose debug console ', ['timestamp']],
    ['diagnose debug application ', ['dhcpc', 'dhcprelay', 'dhcps', 'ike']],
    ['diagnose firewall auth filter ', ['clear', 'group', 'policy', 'user']],
    ['diagnose vpn ike gateway clear ', ['name']],
    ['diagnose test application ', ['dnsproxy', 'miglogd']],
    ['execute log filter ', ['category', 'field', 'reset', 'view-lines']],
    ['diagnose sniffer packet ', ['any', 'port1', 'wan1']],
    ['diagnose hardware deviceinfo nic ', ['port1', 'port2', 'wan1']],
    ['diagnose lldprx port neighbor details ', ['port1', 'wan1']],
  ];
  for (const [line, words] of CASES) {
    it(`${line}? rend ${words.join(', ')}`, () => {
      expect(offered(neuf(), line).sort()).toEqual(expect.arrayContaining([...words]));
    });
  }

  it('une valeur est decrite apres son mot-cle', () => {
    const rows = neuf().getShell().help('diagnose sys session filter src ');
    expect(rows.join('\n')).toContain('<address>');
  });
});

describe('les noms vivants sont proposes', () => {
  it('un tunnel IPsec configure apparait apres `diagnose vpn tunnel up` et se complete', async () => {
    const fw = neuf();
    expect(offered(fw, 'diagnose vpn tunnel up ')).not.toContain('tun1');
    for (const line of ['config vpn ipsec phase1-interface', 'edit "tun1"', 'set interface "port1"', 'set remote-gw 1.2.3.4', 'set psksecret "abc123"', 'next', 'end']) await fw.executeCommand(line);
    expect(offered(fw, 'diagnose vpn tunnel up ')).toContain('tun1');
    expect(offered(fw, 'diagnose vpn ike gateway list name ')).toContain('tun1');
    expect(fw.cliTabCandidates('diagnose vpn tunnel up t')).toEqual(['diagnose vpn tunnel up tun1']);
  });
});

describe('garde-fou : tout mot offert par `?` s\'execute', () => {
  it('aucun mot offert sous diagnose, execute, get et fnsysctl ne repond « action inconnue »', async () => {
    const fw = neuf();
    const queue = ['diagnose', 'execute', 'get', 'fnsysctl'];
    const seen = new Set<string>();
    const paths: string[] = [];
    while (queue.length > 0 && paths.length < 1500) {
      const prefix = queue.shift()!;
      for (const word of offered(fw, `${prefix} `)) {
        if (/^[<[A-Z\d]/.test(word) || word.includes('<') || prefix.split(' ').includes(word)) continue;
        const next = `${prefix} ${word}`;
        if (seen.has(next)) continue;
        seen.add(next);
        paths.push(next);
        if (next.split(' ').length < 8 && !(/-options/.test(next) && next.split(' ').length > 2)) queue.push(next);
      }
    }
    expect(paths.length).toBeGreaterThan(300);
    const skipped = /^execute (reboot|shutdown|factoryreset|factoryreset2|formatlogdisk|erase-disk|enter|ssh|telnet|restore|backup|update|upd|disk|ping|traceroute|tracert|vpn|batch|revision|cfg)/;
    const refused: string[] = [];
    for (const path of paths) {
      if (skipped.test(path)) continue;
      const answer = (await neuf().executeCommand(path)).trim();
      if (/Unknown action|unknown command|Invalid input/i.test(answer)) refused.push(`${path} => ${answer.split('\n').slice(0, 2).join(' // ')}`);
    }
    expect(refused).toEqual([]);
  }, 120_000);
});
