/**
 * PRD-Debug-Fidelite-Cisco.md §4.1 / §7.4 — lot D4.
 *
 * Une commande de debug qui ne peut emettre aucune ligne n'existe pas.
 * Le premier cas est une REGLE lue dans le code : toute categorie
 * declaree doit avoir un emetteur, et les exceptions sont nommees une a
 * une. C'est le meme cliquet que celui des litteraux d'erreur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const SERVICE = 'src/network/devices/router/diag/RouterDebugService.ts';

/**
 * Les deux categories qui restent sans emetteur, chacune pour une raison
 * ecrite. Cette liste ne doit que RETRECIR.
 */
const SANS_EMETTEUR_CONNUES = [
  // NHRP publie `nhrp.packet.*` et ces sujets sont desormais dans
  // l'union `DomainEvent` : l'abonnement compile. Ce qui manque est la
  // MISE EN FORME des lignes de `debug nhrp`, qu'aucune transcription
  // joignable depuis ce reseau n'atteste.
  'ip.nhrp',
  // Aucun evenement ne distingue l'autorisation de l'authentification.
  'aaa.authorization',
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function categoriesSansEmetteur(): string[] {
  const src = readFileSync(SERVICE, 'utf8');
  const declarees = [...src.matchAll(/^\s*\|\s*'([a-z0-9.-]+)'/gm)].map((m) => m[1]);
  const emises = new Set([...src.matchAll(/this\.emit\('([a-z0-9.-]+)'/g)].map((m) => m[1]));
  for (const f of sources('src/network')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/emitLine\('([a-z0-9.-]+)'/g)) {
      emises.add(m[1]);
    }
  }
  // Le moteur IPSec emet par un aiguillage, pas par un litteral.
  emises.add('crypto.ipsec');
  emises.add('crypto.isakmp');
  return declarees.filter((c) => !emises.has(c));
}

describe('no debug category is declared without an emitter', () => {
  it('the list of exceptions only shrinks', () => {
    expect(categoriesSansEmetteur().sort()).toEqual([...SANS_EMETTEUR_CONNUES].sort());
  });

  it('every declared category still has a label', () => {
    const src = readFileSync(SERVICE, 'utf8');
    const declarees = [...src.matchAll(/^\s*\|\s*'([a-z0-9.-]+)'/gm)].map((m) => m[1]);
    for (const c of declarees) {
      expect(src, c).toContain(`case '${c}':`);
    }
  });
});

describe('a family with no trace point is refused, and says which brick is missing', () => {
  it('`debug crypto pki` names the absent certificate events', async () => {
    const r = new CiscoRouter('RP1');
    await r.executeCommand('enable');
    const out = await r.executeCommand('debug crypto pki transactions');
    expect(out).toMatch(/^% Crypto PKI has no trace point/);
    expect(out).toMatch(/publishes no enrolment or validation event/);
    expect(await r.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });

  it('`debug crypto ikev2` names the channel its engine really uses', async () => {
    const r = new CiscoRouter('RP2');
    await r.executeCommand('enable');
    const out = await r.executeCommand('debug crypto ikev2');
    expect(out).toMatch(/^% IKEv2 has no trace point/);
    expect(out).toMatch(/ISAKMP channel/);
    expect(await r.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });

  it('the families that DO have a trace point still arm', async () => {
    const r = new CiscoRouter('RP3');
    await r.executeCommand('enable');
    for (const c of ['debug crypto isakmp', 'debug crypto ipsec']) {
      expect(await r.executeCommand(c), c).toMatch(/debugging is on/);
    }
  });
});

describe('the families D4 gave a command really arm', () => {
  it('each new command answers like IOS and lands in show debugging', async () => {
    const r = new CiscoRouter('RN1');
    await r.executeCommand('enable');
    for (const [cmd, label] of [
      ['debug vrrp', 'VRRP'],
      ['debug glbp', 'GLBP'],
      ['debug radius', 'RADIUS'],
      ['debug tacacs', 'TACACS+'],
      ['debug ntp events', 'NTP events'],
      ['debug ntp packets', 'NTP packets'],
      ['debug aaa authentication', 'AAA Authentication'],
      ['debug aaa accounting', 'AAA Accounting'],
    ] as const) {
      expect(await r.executeCommand(cmd), cmd).toBe(`${label} debugging is on`);
      expect(await r.executeCommand('show debugging'), cmd).toContain(`${label} debugging is on`);
      expect(await r.executeCommand(`no ${cmd}`), cmd).toBe(`${label} debugging is off`);
    }
    expect(await r.executeCommand('show debugging')).toBe('No debug flags are enabled');
  });

  it('an unknown sub-keyword is refused', async () => {
    const r = new CiscoRouter('RN2');
    await r.executeCommand('enable');
    for (const c of ['debug ntp zzz', 'debug aaa zzz']) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
    }
  });
});

describe('`debug ip bgp` traces the session it really has', () => {
  it('a peering that reaches Established is announced, and only real transitions are', async () => {
    const p = new CiscoRouter('BA1');
    const q = new CiscoRouter('BB1');
    new Cable('bc1').connect(p.getPorts()[0], q.getPorts()[0]);
    for (const [d, ip] of [[p, '10.0.9.1'], [q, '10.0.9.2']] as const) {
      for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
        `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end']) {
        await d.executeCommand(c);
      }
    }
    await p.executeCommand('debug ip bgp');
    const lignes: string[] = [];
    collecteDebug((p as unknown as { getDebugService(): { subscribe(f: (l: string) => void): () => void } }).getDebugService(), lignes);
    for (const c of ['configure terminal', 'router bgp 65001',
      'neighbor 10.0.9.2 remote-as 65002', 'end']) {
      await p.executeCommand(c);
    }
    for (const c of ['configure terminal', 'router bgp 65002',
      'neighbor 10.0.9.1 remote-as 65001', 'end']) {
      await q.executeCommand(c);
    }
    await p.executeCommand('show ip bgp summary');

    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.some((l) => /^BGP: 10\.0\.9\.2 went from \w+ to Established$/.test(l))).toBe(true);
    // Une transition d'un etat vers LUI-MEME n'en est pas une.
    for (const l of lignes) {
      const m = /^BGP: \S+ went from (\w+) to (\w+)$/.exec(l);
      if (m) expect(m[1], l).not.toBe(m[2]);
    }
  });
});
