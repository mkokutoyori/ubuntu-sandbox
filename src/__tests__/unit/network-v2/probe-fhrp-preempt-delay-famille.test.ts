/**
 * `preempt delay minimum` retarde, sur les TROIS familles et les DEUX
 * constructeurs.
 *
 * ── Le defaut, trouve en finissant le lot V16 ───────────────────────
 *
 * Le lot V16 avait rendu le delai de preemption reel — **cote Huawei
 * seulement**, sans que rien ne le dise. La mesure faite ensuite montre
 * que le meme reglage etait inerte partout ailleurs, et pour la meme
 * raison a chaque fois : la CLI d'IOS le range sur une **facade**
 * (`FhrpRepository`) que **seuls les affichages lisent**, jamais l'agent
 * qui decide.
 *
 * | Commande                                  | Atteignait l'agent ? |
 * |-------------------------------------------|----------------------|
 * | `vrrp <n> preempt delay minimum <s>`      | non                  |
 * | `standby <n> preempt delay minimum <s>`   | non                  |
 * | `glbp <n> preempt delay minimum <s>`      | non                  |
 * | `vrrp vrid <n> preempt-mode timer delay`  | oui (lot V16)        |
 *
 * Un laboratoire monte sur la colonne Cisco d'un cours voyait donc la
 * commande acceptee, rendue par `show standby`, et sans le moindre
 * effet — le pire des trois etats possibles, puisque l'affichage
 * CONFIRME le reglage.
 *
 * **Et `vrrp <n> authentication md5 key-string`** etait inerte de la
 * meme facon : la cle etait rangee sur la facade et l'agent ne la lisait
 * pas, donc l'authentification VRRP fonctionnait sur VRP et pas sur IOS.
 *
 * ── Une regle, pas trois ────────────────────────────────────────────
 *
 * Le delai vit desormais sur `FhrpAgentBase`, que les trois agents
 * partagent deja. Les trois familles ont la meme commande sous trois
 * orthographes et prennent la meme decision ; en ecrire trois copies,
 * c'etait garantir qu'elles finiraient par differer — ce qui venait
 * precisement d'arriver entre les deux constructeurs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/**
 * Deux routeurs IOS sur un cable, dans le meme groupe de redondance.
 *
 * `b` est monte D'ABORD et prend le role ; `a`, plus prioritaire, arrive
 * ensuite — sans quoi il n'y aurait rien a preempter et la sonde ne
 * mesurerait pas ce qu'elle croit.
 */
async function paire(lignesA: string[], lignesB: string[]) {
  const a = new CiscoRouter(`A${++serie}`);
  const b = new CiscoRouter(`B${serie}`);
  new Cable(`f${serie}`).connect(
    a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
  const monter = async (r: CiscoRouter, ip: string, lignes: string[]) => {
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown',
      ...lignes, 'end']) await r.executeCommand(c);
  };
  await monter(b, '10.0.0.2', lignesB);
  await monter(a, '10.0.0.1', lignesA);
  return { a, b };
}

/**
 * L'ORDRE des lignes de `a` est porteur, et c'est une propriete du
 * protocole plutot qu'une commodite : un routeur qui n'a JAMAIS entendu
 * de pair prend le role tout de suite, ce qui est juste — il n'y a rien
 * a preempter. Le delai ne se mesure donc qu'en montant le groupe
 * d'abord (il devient secours en entendant `b`), puis en elevant la
 * priorite : c'est a cet instant qu'il devient eligible, et c'est cela
 * que le delai retarde.
 */
const etatVrrp = (r: CiscoRouter) =>
  [...r.getVrrpAgent().getConfig().groups.values()][0]?.state ?? 'absent';
const etatHsrp = (r: CiscoRouter) =>
  [...r.getHsrpAgent().getConfig().groups.values()][0]?.state ?? 'absent';

describe('IOS : `vrrp <n> preempt delay minimum` retarde enfin', () => {
  const VIP = 'vrrp 1 ip 10.0.0.254';

  it('sans delai, le routeur prioritaire preempte tout de suite', async () => {
    // Le temoin : sans lui, un delai « qui marche » serait indiscernable
    // d'un moteur qui ne preempte jamais.
    const { a } = await paire(
      [VIP, 'vrrp 1 priority 200', 'vrrp 1 preempt'],
      [VIP, 'vrrp 1 priority 100', 'vrrp 1 preempt']);
    expect(etatVrrp(a)).toBe('master');
  });

  it('avec un delai, il reste en secours tant qu\'il n\'est pas ecoule', async () => {
    const { a } = await paire(
      ['vrrp 1 preempt delay minimum 30', VIP, 'vrrp 1 priority 200'],
      [VIP, 'vrrp 1 priority 100', 'vrrp 1 preempt']);
    expect(etatVrrp(a)).toBe('backup');
  });

  it('et il prend le role une fois le delai passe', async () => {
    vi.useFakeTimers();
    try {
      const { a } = await paire(
        ['vrrp 1 preempt delay minimum 30', VIP, 'vrrp 1 priority 200'],
        [VIP, 'vrrp 1 priority 100', 'vrrp 1 preempt']);
      expect(etatVrrp(a)).toBe('backup');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(etatVrrp(a)).toBe('master');
    } finally { vi.useRealTimers(); }
  });

  it('la valeur atteint l\'AGENT, et pas seulement l\'affichage', async () => {
    // C'est le coeur du defaut : elle etait rendue par `show vrrp` et
    // rangee dans une facade que l'agent ne lit pas.
    const { a } = await paire(
      ['vrrp 1 preempt delay minimum 30', VIP, 'vrrp 1 priority 200'],
      [VIP, 'vrrp 1 priority 100']);
    const g = [...a.getVrrpAgent().getConfig().groups.values()][0];
    expect(g.preemptDelaySec).toBe(30);
  });
});

describe('IOS : `standby <n> preempt delay minimum` retarde enfin', () => {
  const VIP = 'standby 1 ip 10.0.0.254';

  it('sans delai, le routeur prioritaire prend le role', async () => {
    const { a } = await paire(
      [VIP, 'standby 1 priority 200', 'standby 1 preempt'],
      [VIP, 'standby 1 priority 100', 'standby 1 preempt']);
    expect(etatHsrp(a)).toBe('active');
  });

  it('avec un delai, il reste en attente', async () => {
    const { a } = await paire(
      ['standby 1 preempt delay minimum 30', VIP, 'standby 1 priority 200'],
      [VIP, 'standby 1 priority 100', 'standby 1 preempt']);
    expect(etatHsrp(a)).not.toBe('active');
  });

  it('et il prend le role une fois le delai passe', async () => {
    vi.useFakeTimers();
    try {
      const { a } = await paire(
        ['standby 1 preempt delay minimum 30', VIP, 'standby 1 priority 200'],
        [VIP, 'standby 1 priority 100', 'standby 1 preempt']);
      expect(etatHsrp(a)).not.toBe('active');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(etatHsrp(a)).toBe('active');
    } finally { vi.useRealTimers(); }
  });

  it('la valeur atteint l\'agent HSRP', async () => {
    const { a } = await paire(
      ['standby 1 preempt delay minimum 30', VIP, 'standby 1 priority 200'],
      [VIP, 'standby 1 priority 100']);
    const g = [...a.getHsrpAgent().getConfig().groups.values()][0];
    expect(g.preemptDelaySec).toBe(30);
  });
});

describe('IOS : `vrrp <n> authentication` authentifie enfin', () => {
  const VIP = 'vrrp 1 ip 10.0.0.254';

  it('memes cles : le groupe se forme', async () => {
    // Le temoin, monte dans le meme laboratoire : sans lui, un labo mal
    // bati et une authentification cassee seraient indiscernables.
    const { a, b } = await paire(
      ['vrrp 1 authentication md5 key-string LeSecret', VIP, 'vrrp 1 priority 200'],
      ['vrrp 1 authentication md5 key-string LeSecret', VIP, 'vrrp 1 priority 100']);
    expect(etatVrrp(a)).toBe('master');
    expect(etatVrrp(b)).toBe('backup');
  });

  it('cles differentes : chacun se croit seul', async () => {
    const { a, b } = await paire(
      ['vrrp 1 authentication md5 key-string CelleDeA', VIP, 'vrrp 1 priority 200'],
      ['vrrp 1 authentication md5 key-string CelleDeB', VIP, 'vrrp 1 priority 100']);
    expect(etatVrrp(a)).toBe('master');
    expect(etatVrrp(b)).toBe('master');
  });

  it('la cle atteint l\'agent', async () => {
    const { a } = await paire(
      ['vrrp 1 authentication md5 key-string LeSecret', VIP], []);
    const g = [...a.getVrrpAgent().getConfig().groups.values()][0];
    expect(g.authMode).toBe('md5');
    expect(g.authKey).toBe('LeSecret');
  });
});

describe('une seule regle pour les trois familles', () => {
  it('`no preempt` remet l\'horloge du delai a zero', async () => {
    // Sans cette remise a zero, une eligibilite intermittente
    // accumulerait assez de temps pour preempter sans avoir jamais ete
    // stable une seule seconde.
    const { a } = await paire(
      ['vrrp 1 ip 10.0.0.254', 'vrrp 1 priority 200',
        'vrrp 1 preempt delay minimum 30'],
      ['vrrp 1 ip 10.0.0.254', 'vrrp 1 priority 100']);
    const g = [...a.getVrrpAgent().getConfig().groups.values()][0];
    a.getVrrpAgent().setPreempt(g.iface, g.vrid, false);
    expect(g.preemptEligibleSinceMs).toBeNull();
  });

  it('le delai est porte par la BASE, donc les trois agents le lisent', async () => {
    // La propriete qui compte : le champ est le meme objet pour les
    // trois familles, et non trois champs qui se ressemblent.
    const { a } = await paire(
      ['vrrp 1 ip 10.0.0.254', 'vrrp 1 preempt delay minimum 12',
        'standby 2 ip 10.0.0.253', 'standby 2 preempt delay minimum 34'],
      []);
    expect([...a.getVrrpAgent().getConfig().groups.values()][0].preemptDelaySec).toBe(12);
    expect([...a.getHsrpAgent().getConfig().groups.values()][0].preemptDelaySec).toBe(34);
  });
});
