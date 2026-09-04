import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cli {
  executeCommand(c: string): Promise<string> | string;
  cliHelp(s: string): string;
}

function entries(help: string): Array<{ keyword: string; description: string }> {
  return help.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.search(/\s{2,}/);
    return i < 0
      ? { keyword: l, description: '' }
      : { keyword: l.slice(0, i), description: l.slice(i).trim() };
  });
}

const MODES: Array<[string, string[]]> = [
  ['privileged EXEC', []],
  ['global config', ['configure terminal']],
  ['config-if', ['configure terminal', 'interface GigabitEthernet0/0']],
  ['config-line', ['configure terminal', 'line vty 0 4']],
  ['config-router (RIP)', ['configure terminal', 'router rip']],
  ['config-router (BGP)', ['configure terminal', 'router bgp 65001']],
  ['config-router (OSPF)', ['configure terminal', 'router ospf 1']],
  ['config-route-map', ['configure terminal', 'route-map RM permit 10']],
  ['config-time-range', ['configure terminal', 'time-range TR']],
  ['config-track', ['configure terminal', 'track 1 ip sla 1']],
  ['config-dhcp', ['configure terminal', 'ip dhcp pool P']],
  ['standard named ACL', ['configure terminal', 'ip access-list standard S']],
  ['extended named ACL', ['configure terminal', 'ip access-list extended E']],
];

/**
 * `snmp-server community ?` répond `WORD  SNMP community string` sur un
 * vrai IOS, et le mot-clé parent porte la même phrase dans la table
 * canonique. La coïncidence est donc conforme, pas une recopie.
 */
const COINCIDENCES_CONFORMES = new Set(['snmp-server community ']);

async function routeur(): Promise<CiscoRouter & Cli> {
  const r = new CiscoRouter('R1') as CiscoRouter & Cli;
  r.powerOn?.();
  await r.executeCommand('enable');
  return r;
}

describe('un argument est TYPÉ et décrit, jamais la recopie de son parent', () => {
  for (const [nom, mode] of MODES) {
    it(nom, async () => {
      const r = await routeur();
      const fautes: string[] = [];
      const visit = async (prefix: string, parentDesc: string, left: number): Promise<void> => {
        if (left === 0) return;
        await r.executeCommand('end');
        for (const c of mode) await r.executeCommand(c);
        const help = r.cliHelp(prefix);
        if (help.includes('Invalid input') || help.includes('Ambiguous') || !help.trim()) return;
        for (const e of entries(help)) {
          if (e.keyword === '<cr>' || e.keyword.startsWith('%')) continue;
          if (e.keyword === 'WORD' || e.keyword === 'LINE') {
            if (e.description === parentDesc && !COINCIDENCES_CONFORMES.has(prefix)) {
              fautes.push(`${nom}: ${prefix}? -> ${e.keyword} porte la description du parent `
                + `("${parentDesc}") au lieu de la sienne`);
            }
            continue;
          }
          if (/^[<A-Z]/.test(e.keyword)) continue;
          await visit(`${prefix}${e.keyword} `, e.description, left - 1);
        }
      };
      await visit('', '', 3);
      expect(fautes, fautes.join('\n')).toEqual([]);
    }, 120_000);
  }
});

describe('les arguments portent le type qu\'IOS affiche', () => {
  it('un compteur est une plage, pas un mot', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    expect(r.cliHelp('cdp timer ')).toContain('<5-254>');
    expect(r.cliHelp('cdp holdtime ')).toContain('<10-255>');
    expect(r.cliHelp('login delay ')).toContain('<1-65535>');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.cliHelp('ip mtu ')).toContain('<68-9216>');
    expect(r.cliHelp('load-interval ')).toContain('<30-600>');
    expect(r.cliHelp('tunnel key ')).toContain('<0-4294967295>');
  }, 30_000);

  it('une adresse est A.B.C.D et une interface un nom d\'interface', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    expect(r.cliHelp('arp ')).toContain('A.B.C.D');
    expect(r.cliHelp('ip default-network ')).toContain('A.B.C.D');
    expect(r.cliHelp('logging source-interface ')).toMatch(/IFACE\s+Interface used as the source/);
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.cliHelp('tunnel destination ')).toContain('A.B.C.D');
    expect(r.cliHelp('bfd neighbor ')).toContain('A.B.C.D');
  }, 30_000);

  it('les clauses de route-map énumèrent leurs critères', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('route-map RM permit 10');
    const match = r.cliHelp('match ');
    for (const k of ['as-path', 'community', 'interface', 'ip', 'metric', 'tag']) {
      expect(match, `match ? doit offrir ${k}`).toContain(k);
    }
    expect(match).not.toMatch(/^WORD/m);
    const set = r.cliHelp('set ');
    for (const k of ['local-preference', 'metric', 'origin', 'weight']) {
      expect(set, `set ? doit offrir ${k}`).toContain(k);
    }
    expect(set).not.toMatch(/^WORD/m);
  }, 30_000);

  it('une commande sans argument n\'offre pas de WORD', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    for (const cmd of ['cdp run ', 'ip cef ', 'ipv6 cef ', 'ip multicast-routing ',
      'lldp run ', 'service password-encryption ']) {
      const help = r.cliHelp(cmd);
      expect(help, `${cmd}? ne doit pas offrir WORD`).not.toMatch(/^WORD/m);
      expect(help, `${cmd}? doit offrir <cr>`).toContain('<cr>');
    }
  }, 30_000);

  it('une vue est nommée par un WORD, et le délai de saisie est une plage', async () => {
    const r = await routeur();
    expect(r.cliHelp('enable view ')).toMatch(/WORD\s+View name/);
    expect(r.cliHelp('enable view ')).toContain('<cr>');
    await r.executeCommand('configure terminal');
    expect(r.cliHelp('parser view ')).toMatch(/WORD\s+View name/);
    await r.executeCommand('line vty 0 4');
    expect(r.cliHelp('login-timeout ')).toContain('<1-300>');
    expect(r.cliHelp('login-timeout ')).not.toMatch(/^WORD/m);
  }, 30_000);

  it('`service timestamps` garde sa forme nue, son canal étant optionnel', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    const help = r.cliHelp('service timestamps ');
    expect(help).toContain('debug');
    expect(help).toContain('log');
    expect(help).toContain('<cr>');
    expect(await r.executeCommand('service timestamps')).toBe('');
  }, 30_000);
});
