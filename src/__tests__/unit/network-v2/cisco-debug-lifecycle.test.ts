/**
 * PRD-Debug-Fidelite-Cisco.md §3 / §7.2-§7.3 — le cycle de vie.
 *
 * Un drapeau de debug est INDEPENDANT de la configuration : il s'arme,
 * il se desarme, et rien d'autre que `debug`/`no debug` ne decide de son
 * etat. Les deux balayages ci-dessous sont des regles, pas des listes :
 * ils parcourent les memes commandes pour verifier une propriete.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serial = 0;

async function bareRouter(): Promise<CiscoRouter> {
  const r = new CiscoRouter(`RB${++serial}`);
  await r.executeCommand('enable');
  return r;
}

/** Toutes les formes que le routeur accepte, une par famille. */
const ARMABLES = [
  'debug ip packet', 'debug ip icmp', 'debug ip tcp', 'debug ip udp',
  'debug ip routing', 'debug ip nat', 'debug ip arp', 'debug arp',
  'debug ip ospf adj', 'debug ip ospf events', 'debug ip ospf hello',
  'debug ip ospf packet', 'debug ip ospf spf', 'debug ip ospf lsa-generation',
  'debug ip rip', 'debug ip eigrp', 'debug ip bgp', 'debug ip ssh',
  'debug ip nhrp', 'debug ip pim', 'debug ip dhcp server',
  'debug ipv6 packet', 'debug standby', 'debug lldp', 'debug cdp',
  'debug vxlan', 'debug port-security', 'debug crypto isakmp',
  'debug crypto ipsec',
];

describe('a debug flag arms without the protocol it watches', () => {
  it('no family answers with an error on a bare router', async () => {
    const r = await bareRouter();
    for (const c of ARMABLES) {
      const out = await r.executeCommand(c);
      expect(out, c).not.toMatch(/Invalid input|Incomplete|is not enabled/);
      expect(out, c).toMatch(/debugging is on/);
      await r.executeCommand('undebug all');
    }
  });

  it('OSPF armed BEFORE its configuration still sees the adjacency form', async () => {
    const a = new CiscoRouter(`OA${++serial}`);
    const b = new CiscoRouter(`OB${serial}`);
    new Cable(`oc${serial}`).connect(a.getPorts()[0], b.getPorts()[0]);
    for (const [d, ip] of [[a, '10.0.12.1'], [b, '10.0.12.2']] as const) {
      for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
        `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end']) {
        await d.executeCommand(c);
      }
    }
    expect(await a.executeCommand('debug ip ospf adj')).toBe('OSPF adjacency debugging is on');

    const lignes: string[] = [];
    collecteDebug((a as unknown as { getDebugService(): { subscribe(f: (l: string) => void): () => void } }).getDebugService(), lignes);
    for (const d of [a, b]) {
      for (const c of ['configure terminal', 'router ospf 1',
        'network 10.0.12.0 0.0.0.255 area 0', 'end']) {
        await d.executeCommand(c);
      }
    }
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.some((l) => /ADJCHG|adjacency|Nbr/i.test(l))).toBe(true);
  });
});

describe('`no debug X` disarms exactly `debug X`', () => {
  it('every armable family leaves nothing behind', async () => {
    const r = await bareRouter();
    for (const c of ARMABLES) {
      await r.executeCommand(c);
      const off = await r.executeCommand(`no ${c}`);
      expect(off, c).toMatch(/debugging is off/);
      expect(await r.executeCommand('show debugging'), c).toBe('No debug flags are enabled');
    }
  });

  it('`undebug X` is `no debug X`, down to the abbreviation', async () => {
    const r = await bareRouter();
    for (const c of ARMABLES) {
      await r.executeCommand(c);
      await r.executeCommand(c.replace(/^debug /, 'un '));
      expect(await r.executeCommand('show debugging'), c).toBe('No debug flags are enabled');
    }
  });

  it('the sub-keyword forms disarm what they armed, not a neighbour', async () => {
    const r = await bareRouter();
    for (const [on, off] of [
      ['debug ip tcp transactions', 'no debug ip tcp transactions'],
      ['debug ip dhcp server events', 'no debug ip dhcp server events'],
      ['debug ip dhcp server packet', 'no debug ip dhcp server packet'],
    ] as const) {
      await r.executeCommand(on);
      const out = await r.executeCommand(off);
      expect(out, off).toMatch(/debugging is off/);
      expect(await r.executeCommand('show debugging'), off).toBe('No debug flags are enabled');
    }
  });
});

describe('an unknown keyword is refused, never turned into another debug', () => {
  it('`debug ip <unknown>` no longer arms a packet capture', async () => {
    const r = await bareRouter();
    for (const c of ['debug ip zzz', 'debug ip rip events', 'debug ip bgp updates']) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
      expect(await r.executeCommand('show debugging'), c).toBe('No debug flags are enabled');
    }
  });

  it('`debug ip ospf <unknown>` is an invalid keyword, not a missing process', async () => {
    const r = await bareRouter();
    const out = await r.executeCommand('debug ip ospf zzz');
    expect(out).toMatch(/Invalid input/);
    expect(out).not.toMatch(/OSPF is not enabled/);
  });
});

describe('`debug all` exists, and it is guarded', () => {
  it('the router arms everything and lists it', async () => {
    const r = await bareRouter();
    expect(await r.executeCommand('debug all')).toMatch(/All possible debugging has been turned on/);
    const shown = await r.executeCommand('show debugging');
    expect(shown).not.toBe('No debug flags are enabled');
    expect(shown).toMatch(/IP packet debugging is on/);
    expect(await r.executeCommand('undebug all')).toBe('All possible debugging has been turned off');
    expect(await r.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });

  it('a terminal asks before arming it', async () => {
    const r = await bareRouter();
    const plan = (r as unknown as {
      shell: { interactionPlanFor?: (line: string) => { steps: Array<{ kind: string; prompt?: string; defaultAnswer?: string }> } | null };
    }).shell.interactionPlanFor?.('debug all');
    expect(plan).toBeTruthy();
    const confirm = plan!.steps.find((s) => s.kind === 'confirmation');
    expect(confirm).toBeTruthy();
    expect(confirm!.prompt).toMatch(/impact network performance/);
    expect(confirm!.defaultAnswer).toBe('no');
  });
});

describe('`show debugging` is a privileged command', () => {
  it('an unprivileged session cannot read the debug registry', async () => {
    const r = new CiscoRouter(`RU${++serial}`);
    expect(await r.executeCommand('show debugging')).toMatch(/Invalid input/);
    expect(await r.executeCommand('show debug')).toMatch(/Invalid input/);
    await r.executeCommand('enable');
    expect(await r.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });
});
