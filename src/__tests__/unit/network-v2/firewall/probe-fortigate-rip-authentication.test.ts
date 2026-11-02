/**
 * RIP : `config router rip` / `config interface` : `set auth-mode none|text|md5`, `set auth-string` (mode text), `set auth-keychain` (mode md5) et `config router key-chain`
 * (`config key` : id, key-string, algorithm md5) -- FortiOS CLI Reference 7.4.12. Le moteur RIP du depot authentifie deja (RFC 2453 §4.1, texte et MD5) via le rappel
 * `getInterfaceAuth` ; la FortiGate le renseigne. Les durees de vie des cles et les autres algorithmes de la reference ne sont pas evalues et restent refuses.
 * Deux FortiGate se pairent : A annonce 172.16.0.0/16, B l'apprend seulement si les deux cotes portent la meme authentification.
 * Mesure de depart : « unknown attribute auth-mode » ; 2 des 5 cas tombent avant (les deux cas de cles ou de chaines differentes) ; les 3 autres passent des deux cotes : le temoin (sans authentification B apprend le reseau), la meme chaine des deux cotes et le refus d'une key-chain inconnue.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

const keyChain = (name: string, secret: string) =>
  ['config router key-chain', `edit "${name}"`, 'config key', 'edit 1', `set key-string "${secret}"`, 'next', 'end', 'next', 'end'];

const rip = (network: string, interfaceLines: readonly string[]) =>
  ['config router rip', 'set version 2', 'config network', 'edit 1', `set prefix ${network}`, 'next', 'end',
    'config interface', 'edit port2', ...interfaceLines, 'next', 'end', 'end'];

async function pair(aLines: readonly string[], bLines: readonly string[], extraA: readonly string[] = [], extraB: readonly string[] = []) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('port2')!, b.getPort('port2')!);
  await type(a, [...extraA, 'config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next',
    'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end', ...rip('10.9.0.0 255.255.255.0', aLines),
    'config router rip', 'config network', 'edit 2', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'end', 'end']);
  await type(b, [...extraB, 'config system interface', 'edit port2', 'set ip 10.9.0.2 255.255.255.0', 'next', 'end', ...rip('10.9.0.0 255.255.255.0', bLines)]);
  for (const device of [a, b]) {
    (device as unknown as { getRouting(): { getRip(): { sendPeriodicUpdate?: () => void; triggerUpdate?: () => void } | null } }).getRouting().getRip()?.triggerUpdate?.();
  }
  return { a, b, routes: async () => b.executeCommand('get router info routing-table all') };
}

describe('router rip auth-mode et key-chain', () => {
  it('TEMOIN : sans authentification B apprend le reseau de A', async () => {
    const { routes } = await pair([], []);
    expect(await routes()).toContain('172.16.0.0');
  });

  it('meme chaine de texte des deux cotes : le reseau est appris', async () => {
    const { routes } = await pair(['set auth-mode text', 'set auth-string "secret1"'], ['set auth-mode text', 'set auth-string "secret1"']);
    expect(await routes()).toContain('172.16.0.0');
  });

  it('chaines de texte differentes : le reseau est refuse', async () => {
    const { routes } = await pair(['set auth-mode text', 'set auth-string "secret1"'], ['set auth-mode text', 'set auth-string "autre"']);
    expect(await routes()).not.toContain('172.16.0.0');
  });

  it('meme key-chain MD5 des deux cotes : appris ; cles differentes : refuse', async () => {
    const same = await pair(['set auth-mode md5', 'set auth-keychain "kc"'], ['set auth-mode md5', 'set auth-keychain "kc"'], keyChain('kc', 'aaa'), keyChain('kc', 'aaa'));
    expect(await same.routes()).toContain('172.16.0.0');
    const different = await pair(['set auth-mode md5', 'set auth-keychain "kc"'], ['set auth-mode md5', 'set auth-keychain "kc"'], keyChain('kc', 'aaa'), keyChain('kc', 'bbb'));
    expect(await different.routes()).not.toContain('172.16.0.0');
  });

  it('une key-chain inconnue est refusee', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(firewall, ['config router rip', 'config interface', 'edit port2']);
    const reply = await firewall.executeCommand('set auth-keychain "ghost"');
    await type(firewall, ['next', 'end', 'end']);
    expect(reply).toMatch(/entry not found|not found|parse error/i);
  });
});
