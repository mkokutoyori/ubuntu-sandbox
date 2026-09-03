/**
 * Un numero de sequence est un NUMERO, et un prefixe est un PREFIXE.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 * `ip prefix-list <nom> [seq <1-4294967294>] {permit|deny} <A.B.C.D/nn>
 * [ge <0-32>] [le <0-32>]`, avec la contrainte que Cisco enonce dans son
 * propre message de refus — `len < ge <= le` — et
 * `route-map <nom> [permit|deny] [<0-65535>]`.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   ip prefix-list PL seq zorglub permit 10.0.0.0/8
 *       -> ACCEPTE, rendu `ip prefix-list PL seq NaN permit 10.0.0.0/8`
 *   ip prefix-list PL permit 10.0.0.0/99   -> ACCEPTE, rendu tel quel
 *   ip prefix-list PL permit zorglub       -> ACCEPTE, rendu tel quel
 *   ip prefix-list PL permit 10.0.0.0/8 ge zorglub
 *       -> ACCEPTE, rendu `... ge NaN`
 *   route-map RM permit zorglub            -> ACCEPTE, rendu `permit 10`
 *   route-map RM permit 99999999           -> ACCEPTE, rendu tel quel
 *
 * `NaN` dans une configuration n'est pas un defaut d'affichage : elle est
 * REJOUEE a l'import d'une topologie, et `IpPrefixList.evaluate()` est un
 * vrai comparateur de prefixes que la redistribution consulte — un
 * `ge NaN` y decide donc pour de bon.
 *
 * `route-map RM permit zorglub` est le plus sournois des six : le mot mal
 * tape ne disparait pas, il devient la sequence 10, c'est-a-dire une
 * entree que l'operateur n'a pas ecrite et qui peut en ECRASER une
 * existante.
 *
 * Deux defauts de plus, trouves en lisant l'analyseur et ajoutes ici :
 * l'ACTION n'etait pas jugee non plus (`args[i] === 'deny' ? 'deny' :
 * 'permit'` fait de n'importe quel mot un `permit`, le mot etant ensuite
 * consomme), et `no ip prefix-list PL seq zorglub` retirait la sequence
 * `NaN`, c'est-a-dire rien, en silence.
 *
 * `ipv6 prefix-list` partage l'analyseur, donc le jugement, avec son
 * plafond a 128 ; et les deux formes en `no` partagent desormais leur
 * tete, la v6 n'ayant jusqu'ici PAS de `seq` du tout — elle retirait la
 * liste entiere quoi qu'on lui nomme.
 *
 * Discrimine par `git stash` sur `CiscoPolicyCommands.ts` : 29 des 41
 * cas tombent avant correctif. Les 12 autres sont nommes ici :
 *
 *   - `et la forme correcte passe` (`ge 16 le 24`) est le TEMOIN de la
 *     contrainte — sans lui, un analyseur qui refuserait TOUTE borne
 *     satisferait la sonde ;
 *   - les quatre cas de relecture (forme complete, `deny`, sequence
 *     omise, borne haute 4294967294) : ce que la machine faisait deja
 *     bien, et que ce lot ne doit pas casser ;
 *   - les quatre cas valides de `route-map` (sequence retenue, borne
 *     65535, defaut 10, entree rendue) : meme role ;
 *   - les deux `no` legitimes de la famille v4 (liste entiere, sequence
 *     nommee) : ils bornent le refus ajoute a la troisieme forme ;
 *   - la forme v6 correcte, qui passait deja puisque RIEN n'etait juge
 *     de ce cote.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    out.push(String(await d.executeCommand(c)));
  }
  return out.slice(2);
}

async function lignes(d: Dev, prefixe: RegExp): Promise<string[]> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg.split('\n').map((l) => l.trim()).filter((l) => prefixe.test(l));
}

const prefixLists = (d: Dev) => lignes(d, /^ip prefix-list /);
const routeMaps = (d: Dev) => lignes(d, /^route-map /);

describe('`ip prefix-list` — une place typee est jugee', () => {
  const MAUVAISES = [
    'ip prefix-list PL seq zorglub permit 10.0.0.0/8',
    'ip prefix-list PL seq 0 permit 10.0.0.0/8',
    'ip prefix-list PL seq 4294967295 permit 10.0.0.0/8',
    'ip prefix-list PL permit zorglub',
    'ip prefix-list PL permit 10.0.0.0/99',
    'ip prefix-list PL permit 10.0.0.0',
    'ip prefix-list PL permit 999.1.1.1/8',
    'ip prefix-list PL permit 10.0.0.0/8 ge zorglub',
    'ip prefix-list PL permit 10.0.0.0/8 ge 33',
    'ip prefix-list PL permit 10.0.0.0/8 le zorglub',
    'ip prefix-list PL zorglub 10.0.0.0/8',
    'ip prefix-list PL permit 10.0.0.0/8 zorglub 16',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`P${MAUVAISES.indexOf(cmd)}`);
    const [out] = await conf(d, cmd);
    expect(out).toMatch(/Invalid input|Invalid prefix|Invalid sequence|% /);
  });

  it('et AUCUN refus ne laisse de ligne dans la configuration', async () => {
    const d = routeur('PR');
    await conf(d, ...MAUVAISES);
    expect(await prefixLists(d)).toEqual([]);
  });

  it('surtout, plus jamais `NaN` dans une configuration rejouee', async () => {
    const d = routeur('PN');
    await conf(d, ...MAUVAISES);
    expect((await prefixLists(d)).join('\n')).not.toContain('NaN');
  });
});

describe('`ip prefix-list` — la contrainte `len < ge <= le` d IOS', () => {
  it.each([
    'ip prefix-list PL permit 10.0.0.0/8 ge 24 le 16',
    'ip prefix-list PL permit 10.0.0.0/8 ge 4',
    'ip prefix-list PL permit 10.0.0.0/8 le 4',
  ])('`%s` est refuse', async (cmd) => {
    const d = routeur(`C${cmd.length}${cmd.slice(-2)}`);
    const [out] = await conf(d, cmd);
    expect(out).toContain('%');
  });

  it('et la forme correcte passe', async () => {
    const d = routeur('CO');
    const [out] = await conf(d, 'ip prefix-list PL permit 10.0.0.0/8 ge 16 le 24');
    expect(out).not.toContain('%');
  });
});

describe('`ip prefix-list` — ce qui est accepte se RELIT', () => {
  it('la forme complete revient telle qu ecrite', async () => {
    const d = routeur('RA');
    await conf(d, 'ip prefix-list PL seq 5 permit 10.0.0.0/8 ge 16 le 24');
    expect(await prefixLists(d))
      .toContain('ip prefix-list PL seq 5 permit 10.0.0.0/8 ge 16 le 24');
  });

  it('`deny` et un prefixe par defaut aussi', async () => {
    const d = routeur('RB');
    await conf(d, 'ip prefix-list PL seq 10 deny 0.0.0.0/0');
    expect(await prefixLists(d)).toContain('ip prefix-list PL seq 10 deny 0.0.0.0/0');
  });

  it('une sequence omise est REMPLACEE par un numero, jamais par NaN', async () => {
    const d = routeur('RC');
    await conf(d, 'ip prefix-list PL permit 10.0.0.0/8');
    const rendues = await prefixLists(d);
    expect(rendues.length).toBe(1);
    expect(rendues[0]).toMatch(/^ip prefix-list PL seq \d+ permit 10\.0\.0\.0\/8$/);
  });

  it('la borne haute exacte de la sequence reste acceptee', async () => {
    const d = routeur('RD');
    const [out] = await conf(d, 'ip prefix-list PL seq 4294967294 permit 10.0.0.0/8');
    expect(out).not.toContain('%');
    expect((await prefixLists(d)).join('\n')).toContain('seq 4294967294');
  });
});

describe('`route-map` — une sequence mal tapee n en devient pas une autre', () => {
  it('`route-map RM permit zorglub` est refuse', async () => {
    const d = routeur('MA');
    const [out] = await conf(d, 'route-map RM permit zorglub');
    expect(out).toContain('%');
  });

  it('et ne cree AUCUNE entree', async () => {
    const d = routeur('MB');
    await conf(d, 'route-map RM permit zorglub');
    expect(await routeMaps(d)).toEqual([]);
  });

  it('`route-map RM permit 99999999` est refuse — la plage est <0-65535>', async () => {
    const d = routeur('MC');
    const [out] = await conf(d, 'route-map RM permit 99999999');
    expect(out).toContain('%');
  });

  it('une sequence valide est retenue et rendue', async () => {
    const d = routeur('MD');
    await conf(d, 'route-map RM permit 20');
    expect(await routeMaps(d)).toContain('route-map RM permit 20');
  });

  it('la borne haute exacte reste acceptee', async () => {
    const d = routeur('ME');
    const [out] = await conf(d, 'route-map RM permit 65535');
    expect(out).not.toContain('%');
    expect((await routeMaps(d)).join('\n')).toContain('65535');
  });

  it('une sequence omise vaut 10, comme sur IOS', async () => {
    const d = routeur('MF');
    await conf(d, 'route-map RM permit');
    expect(await routeMaps(d)).toContain('route-map RM permit 10');
  });
});

describe('non-regression — le mecanisme derriere continue de servir', () => {
  it('deux entrees d une meme liste coexistent et se relisent', async () => {
    const d = routeur('NA');
    await conf(d,
      'ip prefix-list PL seq 5 permit 10.0.0.0/8',
      'ip prefix-list PL seq 10 deny 192.168.0.0/16');
    const rendues = await prefixLists(d);
    expect(rendues).toContain('ip prefix-list PL seq 5 permit 10.0.0.0/8');
    expect(rendues).toContain('ip prefix-list PL seq 10 deny 192.168.0.0/16');
  });

  it('`no ip prefix-list` retire toujours', async () => {
    const d = routeur('NB');
    await conf(d, 'ip prefix-list PL seq 5 permit 10.0.0.0/8', 'no ip prefix-list PL');
    expect((await prefixLists(d)).join('\n')).not.toContain('PL');
  });

  it('`no ip prefix-list PL seq 5` ne retire QUE cette entree', async () => {
    const d = routeur('NC');
    await conf(d,
      'ip prefix-list PL seq 5 permit 10.0.0.0/8',
      'ip prefix-list PL seq 10 deny 192.168.0.0/16',
      'no ip prefix-list PL seq 5');
    const rendues = await prefixLists(d);
    expect(rendues.join('\n')).not.toContain('10.0.0.0/8');
    expect(rendues).toContain('ip prefix-list PL seq 10 deny 192.168.0.0/16');
  });

  it('et `no ip prefix-list PL seq zorglub` est refuse plutot qu inerte', async () => {
    const d = routeur('ND');
    await conf(d, 'ip prefix-list PL seq 5 permit 10.0.0.0/8');
    const [out] = await conf(d, 'no ip prefix-list PL seq zorglub');
    expect(out).toContain('Invalid input');
    expect(await prefixLists(d)).toContain('ip prefix-list PL seq 5 permit 10.0.0.0/8');
  });
});

describe('`ipv6 prefix-list` partage l analyseur, donc le meme jugement', () => {
  const listesV6 = (d: Dev) => lignes(d, /^ipv6 prefix-list /);

  it.each([
    'ipv6 prefix-list P6 seq zorglub permit 2001:db8::/32',
    'ipv6 prefix-list P6 permit zorglub',
    'ipv6 prefix-list P6 permit 2001:db8::/129',
    'ipv6 prefix-list P6 permit 2001:db8::/32 ge zorglub',
    'ipv6 prefix-list P6 permit 2001:db8::/32 ge 129',
    'ipv6 prefix-list P6 permit 2001:db8::/32 ge 16',
  ])('`%s` est refuse', async (cmd) => {
    const d = routeur(`X${cmd.length}${cmd.slice(-3)}`);
    const [out] = await conf(d, cmd);
    expect(out).toContain('%');
    expect(await listesV6(d)).toEqual([]);
  });

  it('la forme correcte passe et se relit, avec le plafond a 128', async () => {
    const d = routeur('X6');
    const [out] = await conf(d, 'ipv6 prefix-list P6 seq 5 permit 2001:db8::/32 ge 48 le 64');
    expect(out).not.toContain('%');
    expect(await listesV6(d))
      .toContain('ipv6 prefix-list P6 seq 5 permit 2001:db8::/32 ge 48 le 64');
  });

  it('`no ipv6 prefix-list P6 seq 5` ne retire QUE cette entree', async () => {
    const d = routeur('X7');
    await conf(d,
      'ipv6 prefix-list P6 seq 5 permit 2001:db8::/32',
      'ipv6 prefix-list P6 seq 10 deny 2001:db8:1::/48',
      'no ipv6 prefix-list P6 seq 5');
    const rendues = await listesV6(d);
    expect(rendues.join('\n')).not.toContain('2001:db8::/32');
    expect(rendues).toContain('ipv6 prefix-list P6 seq 10 deny 2001:db8:1::/48');
  });

  it('et une sequence malformee y est refusee aussi', async () => {
    const d = routeur('X8');
    await conf(d, 'ipv6 prefix-list P6 seq 5 permit 2001:db8::/32');
    const [out] = await conf(d, 'no ipv6 prefix-list P6 seq zorglub');
    expect(out).toContain('Invalid input');
    expect(await listesV6(d)).toContain('ipv6 prefix-list P6 seq 5 permit 2001:db8::/32');
  });
});
