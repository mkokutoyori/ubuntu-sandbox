/**
 * VRRP : le delai de preemption RETARDE vraiment, et
 * `authentication-mode` authentifie vraiment.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `PRD-CLI-Fidelite-VRP.md` §24.4 le nommait sans le traiter :
 * `preempt-mode timer delay` et `authentication-mode` etaient ranges,
 * rendus et rejoues, mais **le moteur ne differait aucune prise de role
 * et n'authentifiait rien**. Le lot V15 leur avait donne un magasin
 * unique au lieu de les PERDRE cote commutateur, ce qui etait un progres
 * ; les faire agir restait ouvert, et c'est ce lot.
 *
 * Consequences mesurees avant correctif : un routeur configure avec un
 * delai de preemption reprenait le role de maitre **immediatement**, et
 * deux routeurs portant des cles DIFFERENTES formaient un groupe
 * parfaitement normal — l'authentification etait un affichage.
 *
 * ── Ce qui a ete verifie, et ce que le materiel impose ──────────────
 *
 * **Le proprietaire de l'adresse ignore le delai.** RFC 5798 §6.1 :
 * « the router that owns the IPvX address associated with the virtual
 * router always preempts, independent of the setting of this flag ».
 * C'est le cas qu'une implementation naive rate.
 *
 * **Le delai retarde la PREEMPTION, pas le BASCULEMENT.** La
 * documentation Huawei donne sa raison d'etre — « to prevent frequent
 * switching of the VRRP group status » — et conseille explicitement de
 * laisser le delai a 0 sur le routeur de secours « to preempt the master
 * role immediately after the master device is faulty ». Retarder la
 * reprise quand il n'y a plus de maitre ferait perdre du trafic pour
 * rien.
 *
 * **L'authentification est une extension de constructeur.** VRRPv2
 * (RFC 2338 §5.3.6) la numerotait ; **RFC 3768 l'a RETIREE** — « VRRP
 * does not currently support authentication ». Ce que font Huawei et
 * Cisco aujourd'hui est donc herite, et le dire vaut mieux que de
 * laisser croire que c'est normalise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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
 * Deux routeurs VRP sur un cable, dans le meme groupe VRRP.
 *
 * `a` porte la priorite haute — c'est donc lui qui preempte — et `b` la
 * basse. Ils sont montes dans cet ORDRE : `b` d'abord, pour qu'il soit
 * deja maitre quand `a` arrive, sans quoi il n'y aurait rien a preempter
 * et la sonde ne mesurerait pas ce qu'elle croit.
 */
async function paire(o: {
  prioA?: number; prioB?: number;
  confA?: string[]; confB?: string[];
} = {}) {
  const a = new HuaweiRouter(`A${++serie}`);
  const b = new HuaweiRouter(`B${serie}`);
  new Cable(`v${serie}`).connect(
    a.getPort('GE0/0/0')!, b.getPort('GE0/0/0')!);

  const monter = async (
    r: HuaweiRouter, ip: string, prio: number, extra: string[],
  ) => {
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      `ip address ${ip} 255.255.255.0`, 'undo shutdown',
      // L'authentification est posee AVANT `virtual-ip`, qui est ce qui
      // met le groupe en service : dans l'autre ordre, la premiere
      // annonce partirait NUE et serait ecartee pour desaccord de TYPE,
      // ce qui masquerait le desaccord de cle que la sonde vise. Un vrai
      // operateur a la meme contrainte, et c'est pourquoi la
      // documentation fait configurer le groupe avant de l'activer.
      ...extra,
      'vrrp vrid 1 virtual-ip 10.0.0.254',
      `vrrp vrid 1 priority ${prio}`,
      'return']) await r.executeCommand(c);
  };
  await monter(b, '10.0.0.2', o.prioB ?? 100, o.confB ?? []);
  await monter(a, '10.0.0.1', o.prioA ?? 200, o.confA ?? []);
  return { a, b };
}

const etat = (r: HuaweiRouter): string => {
  // La cle du groupe porte le nom REEL du port (`GE0/0/0`), pas celui
  // que la CLI accepte en entree : VRP resout l'abreviation.
  const g = [...r.getVrrpAgent().getConfig().groups.values()][0];
  return g?.state ?? 'absent';
};

describe('le delai de preemption retarde la prise de role', () => {
  it('sans delai, le routeur prioritaire preempte tout de suite', async () => {
    // Le temoin : sans lui, un delai « qui marche » serait indiscernable
    // d'un moteur qui ne preempte jamais.
    const { a } = await paire();
    expect(etat(a)).toBe('master');
  });

  it('avec un delai, il RESTE en secours tant qu\'il n\'est pas ecoule', async () => {
    // Le cas central. Avant correctif il devenait maitre immediatement.
    const { a } = await paire({
      confA: ['vrrp vrid 1 preempt-mode timer delay 20'],
    });
    expect(etat(a)).toBe('backup');
  });

  it('et il devient maitre une fois le delai passe', async () => {
    vi.useFakeTimers();
    try {
      const { a } = await paire({
        confA: ['vrrp vrid 1 preempt-mode timer delay 20'],
      });
      expect(etat(a)).toBe('backup');
      // Le minuteur est ARME : la preemption ne doit pas attendre la
      // prochaine annonce recue, sinon un maitre qui se tait la
      // bloquerait pour toujours.
      await vi.advanceTimersByTimeAsync(21_000);
      expect(etat(a)).toBe('master');
    } finally { vi.useRealTimers(); }
  });

  it('le PROPRIETAIRE de l\'adresse ignore le delai', async () => {
    // RFC 5798 §6.1 : il preempte « independent of the setting of this
    // flag ». C'est le cas qu'une implementation naive rate.
    //
    // La possession se MONTE, elle ne se configure pas : la CLI refuse
    // `priority 255` (« reserve au proprietaire »), ce qui est juste —
    // donc sans la regle de possession cette priorite etait
    // INATTEIGNABLE et tout le code qui la traite etait mort. Ici
    // l'interface de `a` porte exactement l'adresse virtuelle.
    const a = new HuaweiRouter(`O${++serie}`);
    const b = new HuaweiRouter(`Q${serie}`);
    new Cable(`o${serie}`).connect(a.getPort('GE0/0/0')!, b.getPort('GE0/0/0')!);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.2 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200',
      'return']) await b.executeCommand(c);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.254 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 preempt-mode timer delay 20',
      'vrrp vrid 1 virtual-ip 10.0.0.254',
      'return']) await a.executeCommand(c);
    expect(etat(a)).toBe('master');
  });

  it('le proprietaire annonce 255 SUR LE FIL, et ne l\'a pas configure', async () => {
    // L'assertion porte sur ce que le VOISIN a recu, pas sur l'etat
    // local : une priorite juste chez soi et fausse sur le fil ne
    // servirait a rien, et c'est le voisin qui decide de s'effacer.
    const a = new HuaweiRouter(`W${++serie}`);
    const b = new HuaweiRouter(`X${serie}`);
    new Cable(`p${serie}`).connect(a.getPort('GE0/0/0')!, b.getPort('GE0/0/0')!);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.2 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200',
      'return']) await b.executeCommand(c);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.254 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.0.254', 'return']) await a.executeCommand(c);
    const chezA = [...a.getVrrpAgent().getConfig().groups.values()][0];
    // La CLI refuse `priority 255` — c'est juste, elle est reservee —
    // donc la valeur ne peut venir QUE de la possession.
    expect(chezA.priority).not.toBe(255);
    const chezB = [...b.getVrrpAgent().getConfig().groups.values()][0];
    expect(chezB.masterPriority).toBe(255);
    expect(etat(b)).toBe('backup');
  });

  it('`undo preempt-mode` interdit la preemption, delai ou pas', async () => {
    const { a } = await paire({
      confA: ['vrrp vrid 1 preempt-mode timer delay 20', 'undo vrrp vrid 1 preempt-mode'],
    });
    expect(etat(a)).toBe('backup');
  });

  it('le delai est rendu par la configuration, donc rejoue', async () => {
    const { a } = await paire({
      confA: ['vrrp vrid 1 preempt-mode timer delay 20'],
    });
    expect(await a.executeCommand('display current-configuration'))
      .toContain('vrrp vrid 1 preempt-mode timer delay 20');
  });
});

describe('`authentication-mode` authentifie', () => {
  it('memes cles : le groupe se forme normalement', async () => {
    // Le temoin, monte dans le meme laboratoire : sans lui, un labo mal
    // bati et une authentification cassee seraient indiscernables.
    const { a, b } = await paire({
      confA: ['vrrp vrid 1 authentication-mode simple LeSecret'],
      confB: ['vrrp vrid 1 authentication-mode simple LeSecret'],
    });
    expect(etat(a)).toBe('master');
    expect(etat(b)).toBe('backup');
  });

  it('cles DIFFERENTES : l\'annonce est ECARTEE, donc chacun se croit seul', async () => {
    // Avant correctif, les deux formaient un groupe parfaitement normal.
    // Ecartee, l'annonce ne devient ni un maitre ni une preuve de vie —
    // donc les deux se declarent maitres, ce qui est exactement le
    // symptome que produit une vraie discordance de cle.
    const { a, b } = await paire({
      confA: ['vrrp vrid 1 authentication-mode simple LeVraiSecret'],
      confB: ['vrrp vrid 1 authentication-mode simple CelleDeLAutre'],
    });
    expect(etat(a)).toBe('master');
    expect(etat(b)).toBe('master');
  });

  it('modes DIFFERENTS : le desaccord de type est aussi un refus', async () => {
    const { a, b } = await paire({
      confA: ['vrrp vrid 1 authentication-mode simple LeSecret'],
      confB: ['vrrp vrid 1 authentication-mode md5 LeSecret'],
    });
    expect(etat(b)).toBe('master');
    expect(etat(a)).toBe('master');
  });

  it('le refus distingue le TYPE de la CLE', async () => {
    // Les deux motifs envoient l'operateur a deux endroits : une
    // commande qui manque, ou un secret qui differe.
    const motifs: string[] = [];
    const b = new HuaweiRouter(`Z${++serie}`);
    const a = new HuaweiRouter(`Y${serie}`);
    for (const r of [a, b]) {
      r.getBus().subscribe('vrrp.auth.rejected',
        (e) => { motifs.push((e.payload as { reason: string }).reason); });
    }
    new Cable(`w${serie}`).connect(
      a.getPort('GE0/0/0')!, b.getPort('GE0/0/0')!);
    for (const [r, ip, conf] of [
      [b, '10.0.0.2', 'vrrp vrid 1 authentication-mode simple CelleDeB'],
      [a, '10.0.0.1', 'vrrp vrid 1 authentication-mode simple CelleDeA'],
    ] as const) {
      for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
        `ip address ${ip} 255.255.255.0`, 'undo shutdown',
        conf, 'vrrp vrid 1 virtual-ip 10.0.0.254', 'return']) {
        await r.executeCommand(c);
      }
    }
    expect(motifs).toContain('key');
    expect(motifs).not.toContain('type');
  });

  it('un groupe SANS authentification accepte une annonce qui en porte une', async () => {
    // Le cote non configure doit VOIR l'asymetrie plutot que de perdre
    // les deux sens d'un coup : c'est ce qui rend la maquette
    // diagnosticable.
    const { b } = await paire({
      confA: ['vrrp vrid 1 authentication-mode simple LeSecret'],
      confB: [],
    });
    expect(etat(b)).toBe('backup');
  });

  it('la ligne est rendue par la configuration', async () => {
    const { a } = await paire({
      confA: ['vrrp vrid 1 authentication-mode simple LeSecret'],
    });
    expect(await a.executeCommand('display current-configuration'))
      .toContain('vrrp vrid 1 authentication-mode simple');
  });
});
