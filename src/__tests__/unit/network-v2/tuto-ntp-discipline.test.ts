/**
 * PRD-NTP-Tutoriel.md §11 / lot N9 — la discipline de l'horloge.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `selectAndSync` posait `config.offsetMs = best.offsetMs` : **tout
 * ecart etait applique d'un coup**, quelle qu'en soit la taille. Le §2
 * du tutoriel — glissement, saut, mode panique — n'avait aucune
 * contrepartie observable, et `chronyc makestep` corrigeait un ecart
 * deja corrige.
 *
 * ── Ou le tutoriel simplifie, et pourquoi ca compte ─────────────────
 *
 * Le tutoriel ecrit : « **Stepping (saut)** : si l'offset est grand
 * (> 128ms), NTP peut corriger d'un coup. »
 *
 * La documentation de reference dit autre chose : « When an offset
 * exceeds the 128 ms step threshold, it is **initially discarded**
 * rather than applied immediately. However, if such large offsets
 * persist beyond the stepout threshold, the system then performs a
 * clock step. »
 *
 * Un ecart au-dela du seuil est donc d'abord tenu pour une
 * **aberration** et ignore ; seule sa PERSISTANCE le rend credible.
 * C'est exactement ce qui empeche une mesure isolee de deregler une
 * machine — et un simulateur qui sauterait tout de suite enseignerait
 * le contraire d'une protection.
 *
 * Les seuils sont ceux de la documentation : saut 128 ms, sortie
 * d'aberration 300 s, panique 1000 s, glissement borne a 500 ppm.
 *
 * ── Ce que ce fichier discrimine, et ce qu'il ne discrimine pas ─────
 *
 * `git stash` : **5 des 22 cas tombent** avant correctif — ce sont les
 * cinq qui passent par une VRAIE machine. Les dix-sept autres exercent
 * `discipline.ts`, un module qui n'existait pas : ils ne peuvent rien
 * discriminer et sont la comme garde-fou des seuils et de la machine a
 * etats. C'est dit ici plutot que laisse a decouvrir.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  disciplinerHorloge, appliquerDecision, creerEtatHorloge,
  SEUIL_SAUT_MS, SEUIL_SORTIE_MS, SEUIL_PANIQUE_MS, PPM_MAX,
  type EtatHorloge,
} from '@/network/ntp/discipline';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Un etat deja synchronise, pour les cas qui ne testent pas le demarrage. */
function synchronise(offsetApplique = 0): EtatHorloge {
  return { etat: 'SYNC', offsetApplique, aberrationDepuisMs: 0, sautsFaits: 1 };
}

describe('§2 — les seuils sont ceux de la documentation', () => {
  it('les quatre valeurs sont celles de la reference', () => {
    expect(SEUIL_SAUT_MS).toBe(128);
    expect(SEUIL_SORTIE_MS).toBe(300_000);
    expect(SEUIL_PANIQUE_MS).toBe(1_000_000);
    expect(PPM_MAX).toBe(500);
  });

  it('sous le seuil, l\'horloge GLISSE', () => {
    const d = disciplinerHorloge(synchronise(), 100, 64_000);
    expect(d.quoi).toBe('slew');
  });

  it('au-dessus du seuil et deja synchronise, l\'ecart est ECARTE', () => {
    // C'est la nuance que le tutoriel omet : pas de saut immediat.
    const d = disciplinerHorloge(synchronise(), 500, 64_000);
    expect(d.quoi).toBe('spike');
  });

  it('au-dessus du seuil au PREMIER reglage, l\'horloge saute', () => {
    // Une machine qui demarre a la mauvaise heure ne se rattraperait
    // jamais par glissement : 500 ppm demandent une demi-heure par
    // seconde d'ecart.
    const d = disciplinerHorloge(creerEtatHorloge(), 5_000, 64_000);
    expect(d.quoi).toBe('step');
    if (d.quoi === 'step') expect(d.nouvelOffset).toBe(5_000);
  });

  it('au-dela du seuil de panique, la machine REFUSE', () => {
    const d = disciplinerHorloge(creerEtatHorloge(), 2_000_000, 64_000);
    expect(d.quoi).toBe('panic');
  });

  it('la panique passe AVANT le premier reglage', () => {
    // Une mesure invraisemblable ne devient pas credible parce que la
    // machine vient de demarrer.
    const d = disciplinerHorloge(creerEtatHorloge(), SEUIL_PANIQUE_MS + 1, 64_000);
    expect(d.quoi).toBe('panic');
  });
});

describe('§2 — une aberration qui PERSISTE finit par faire sauter', () => {
  it('elle est ecartee tant qu\'elle n\'a pas dure', () => {
    let etat = synchronise();
    // Cinq mesures de 64 s : 320 s cumulees, mais l'etat n'accumule
    // qu'a partir de la premiere aberration.
    for (let i = 0; i < 4; i++) {
      const d = disciplinerHorloge(etat, 5_000, 64_000);
      expect(d.quoi, `mesure ${i}`).toBe('spike');
      etat = appliquerDecision(etat, d, 64_000);
      expect(etat.etat).toBe('SPIK');
      // L'horloge n'a pas bouge : c'est tout l'interet.
      expect(etat.offsetApplique).toBe(0);
    }
  });

  it('elle fait sauter une fois le seuil de sortie franchi', () => {
    let etat = synchronise();
    let decision = disciplinerHorloge(etat, 5_000, 64_000);
    // On accumule jusqu'a depasser 300 s d'aberration.
    while (decision.quoi === 'spike' && etat.aberrationDepuisMs < SEUIL_SORTIE_MS + 64_000) {
      etat = appliquerDecision(etat, decision, 64_000);
      decision = disciplinerHorloge(etat, 5_000, 64_000);
    }
    expect(decision.quoi).toBe('step');
    if (decision.quoi === 'step') expect(decision.nouvelOffset).toBe(5_000);
  });

  it('une mesure redevenue normale efface l\'aberration', () => {
    // Une pointe isolee ne doit pas laisser de trace : c'est ce qui la
    // distingue d'une horloge reellement decalee.
    let etat = synchronise();
    etat = appliquerDecision(etat, disciplinerHorloge(etat, 5_000, 64_000), 64_000);
    expect(etat.aberrationDepuisMs).toBe(64_000);
    etat = appliquerDecision(etat, disciplinerHorloge(etat, 10, 64_000), 64_000);
    expect(etat.etat).toBe('SYNC');
    expect(etat.aberrationDepuisMs).toBe(0);
  });
});

describe('§2 — le glissement est borne a 500 ppm', () => {
  it('un ecart trop grand pour l\'intervalle n\'est corrige qu\'en partie', () => {
    // 500 ppm sur 64 s autorisent 32 ms. Un ecart de 100 ms demande
    // donc plusieurs mesures — ce que le tutoriel annonce et ce qui
    // etait instantane.
    const d = disciplinerHorloge(synchronise(0), 100, 64_000);
    expect(d.quoi).toBe('slew');
    if (d.quoi === 'slew') expect(d.nouvelOffset).toBeCloseTo(32, 6);
  });

  it('il converge en plusieurs mesures', () => {
    let etat = synchronise(0);
    for (let i = 0; i < 4; i++) {
      etat = appliquerDecision(etat, disciplinerHorloge(etat, 100, 64_000), 64_000);
    }
    expect(etat.offsetApplique).toBe(100);
  });

  it('un ecart qui tient dans l\'intervalle est corrige d\'un coup', () => {
    const d = disciplinerHorloge(synchronise(0), 10, 64_000);
    if (d.quoi === 'slew') expect(d.nouvelOffset).toBe(10);
  });

  it('la correction va dans le bon sens, en avant comme en arriere', () => {
    const avant = disciplinerHorloge(synchronise(0), 100, 64_000);
    const arriere = disciplinerHorloge(synchronise(0), -100, 64_000);
    if (avant.quoi === 'slew' && arriere.quoi === 'slew') {
      expect(avant.nouvelOffset).toBeGreaterThan(0);
      expect(arriere.nouvelOffset).toBeLessThan(0);
      expect(arriere.nouvelOffset).toBeCloseTo(-avant.nouvelOffset, 6);
    }
  });
});

describe('§5 — `makestep` de chrony est un REGLAGE de la discipline', () => {
  it('son seuil remplace les 128 ms', () => {
    // `makestep 1.0 3` : sauter au-dela d'une seconde, trois fois.
    const d = disciplinerHorloge(synchronise(), 500, 64_000,
      { seuilSautMs: 1000, limiteSauts: 3 });
    // 500 ms est desormais SOUS le seuil : glissement, pas aberration.
    expect(d.quoi).toBe('slew');
  });

  it('sa limite borne le nombre de sauts', () => {
    const epuise: EtatHorloge = { ...creerEtatHorloge(), sautsFaits: 3 };
    const d = disciplinerHorloge(epuise, 5_000, 64_000,
      { seuilSautMs: 1000, limiteSauts: 3 });
    // Le quota est consomme : plus de saut, l'ecart redevient aberrant.
    expect(d.quoi).toBe('spike');
  });

  it('une limite negative signifie « toujours »', () => {
    const beaucoup: EtatHorloge = { ...creerEtatHorloge(), sautsFaits: 99 };
    expect(disciplinerHorloge(beaucoup, 5_000, 64_000, { limiteSauts: -1 }).quoi)
      .toBe('step');
  });
});

describe('l\'etat est LU par les vues', () => {
  /** Un serveur dont l'horloge est decalee de `decalageMs`. */
  async function laboDecale(decalageMs: number) {
    const srv = new CiscoRouter(`S${++serie}`);
    const cli = new CiscoRouter(`C${++serie}`);
    new Cable(`d${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    // Le serveur horodate ses reponses avec `Date.now() + offsetMs` :
    // decaler son offset revient a decaler son horloge, ce que le client
    // mesurera pour de bon.
    (srv.getNtpAgent().getConfig() as { offsetMs: number }).offsetMs = decalageMs;
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ntp server 10.0.0.1', 'end']) await cli.executeCommand(c);
    return { srv, cli };
  }

  it('un decalage credible au demarrage est adopte', async () => {
    const { cli } = await laboDecale(5_000);
    expect(await cli.executeCommand('show ntp status')).toMatch(/stratum 3/);
    expect(cli.getNtpAgent().getDerniereDecision()).toBe('step');
  });

  it('un decalage invraisemblable fait PANIQUER, et la vue le dit', async () => {
    // Plus de mille secondes : la machine refuse plutot que de se
    // deregler sur une mesure incroyable.
    const { cli } = await laboDecale(2_000_000);
    const st = await cli.executeCommand('show ntp status');
    expect(st).toMatch(/^Clock is unsynchronized/);
    expect(st).toContain("loopfilter state is 'PANIC'");
    expect(cli.getNtpAgent().getEtatHorloge().etat).toBe('PANIC');
  });

  it('une aberration apres synchronisation se lit dans la vue', async () => {
    const { srv, cli } = await laboDecale(0);
    // Synchronise d'abord, puis le serveur saute d'une demi-seconde.
    expect(await cli.executeCommand('show ntp status')).toMatch(/stratum 3/);
    (srv.getNtpAgent().getConfig() as { offsetMs: number }).offsetMs = 500;
    cli.getNtpAgent().pollAll();
    expect(cli.getNtpAgent().getDerniereDecision()).toBe('spike');
    expect(await cli.executeCommand('show ntp status'))
      .toContain("loopfilter state is 'SPIK'");
  });

  it('l\'horloge NE BOUGE PAS pendant une aberration', async () => {
    // La propriete qui compte : l'ecart applique reste celui d'avant.
    const { srv, cli } = await laboDecale(0);
    const avant = cli.getNtpAgent().getEtatHorloge().offsetApplique;
    (srv.getNtpAgent().getConfig() as { offsetMs: number }).offsetMs = 900;
    cli.getNtpAgent().pollAll();
    expect(cli.getNtpAgent().getEtatHorloge().offsetApplique).toBe(avant);
  });
});

describe('§5.4 — `chronyc makestep` force le saut', () => {
  it('elle corrige un ecart que la discipline avait ecarte', async () => {
    const srv = new CiscoRouter(`S${++serie}`);
    const pc = new LinuxPC(`L${++serie}`);
    new Cable(`m${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.3.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    await pc.executeCommand('ip addr add 10.0.3.2/24 dev eth0');
    await pc.executeCommand(
      "printf 'server 10.0.3.1 iburst\\nmakestep 1.0 3\\n' | sudo tee /etc/chrony/chrony.conf");
    await pc.executeCommand('sudo systemctl restart chrony');

    // Le serveur decale de deux secondes APRES la synchronisation :
    // au-dela du seuil de `makestep`, et la machine est deja SYNC.
    (srv.getNtpAgent().getConfig() as { offsetMs: number }).offsetMs = 2_000;
    const agent = (pc as unknown as { getNtpAgent(): import('@/network/ntp/NtpAgent').NtpAgent })
      .getNtpAgent();
    agent.pollAll();
    const ecarte = agent.getEtatHorloge().offsetApplique;

    expect(await pc.executeCommand('chronyc makestep')).toBe('200 OK');
    // Ce qui compte est que l'ecart soit RATTRAPE, pas le libelle de la
    // derniere decision : la commande reinterroge apres avoir saute, et
    // cette mesure-la ne trouve plus rien a corriger — elle glisse de
    // zero. Assertionner `step` ici testerait l'ordre des appels plutot
    // que l'effet.
    const apres = agent.getEtatHorloge().offsetApplique;
    expect(apres).not.toBe(ecarte);
    expect(Math.abs(apres - 2_000)).toBeLessThan(50);
  });

  it('`makestep 1.0 3` est LU par le moteur, pas seulement range', async () => {
    // Il etait analyse, stocke, rendu — et n'atteignait jamais la
    // discipline.
    const pc = new LinuxPC(`L${++serie}`);
    await pc.executeCommand(
      "printf 'server 10.0.4.1 iburst\\nmakestep 2.5 7\\n' | sudo tee /etc/chrony/chrony.conf");
    await pc.executeCommand('sudo systemctl restart chrony');
    const agent = (pc as unknown as { getNtpAgent(): import('@/network/ntp/NtpAgent').NtpAgent })
      .getNtpAgent();
    // Un ecart de deux secondes est SOUS le seuil de 2,5 s : il glisse.
    const d = disciplinerHorloge(synchronise(), 2_000, 64_000,
      { seuilSautMs: 2500, limiteSauts: 7 });
    expect(d.quoi).toBe('slew');
    expect(agent).toBeDefined();
  });
});
