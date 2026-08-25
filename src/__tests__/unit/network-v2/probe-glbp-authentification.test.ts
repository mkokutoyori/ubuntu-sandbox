/**
 * GLBP : `glbp <n> authentication` authentifie, et `preempt delay
 * minimum` retarde.
 *
 * ── Le defaut, et il etait pire que celui de VRRP ───────────────────
 *
 * Le lot V18 avait nomme ce point sans le traiter. La mesure faite
 * ensuite montre que les deux commandes n'etaient pas seulement inertes,
 * elles etaient **JETEES** :
 *
 * - `case 'forwarder': case 'authentication': return '';` — la clé
 *   n'atteignait meme pas la facade, donc `glbp <n> authentication md5
 *   key-string …` ne laissait **aucune trace nulle part** : ni effet, ni
 *   configuration rendue, rien a relire ;
 * - `case 'preempt'` ne lisait pas `delay minimum` du tout, si bien que
 *   la valeur disparaissait dans le mot-cle.
 *
 * C'est un cran en dessous du defaut de VRRP, ou la valeur etait au
 * moins rangee et affichee : ici, l'operateur tape une commande de
 * durcissement, la machine repond sans rien dire, et **plus rien n'en
 * temoigne**.
 *
 * ── Ce que le materiel fait, verifie ────────────────────────────────
 *
 * « A device within a GLBP group with a different authentication string
 * than other devices will be ignored by other group members », et « a
 * device will ignore incoming GLBP packets from devices that do not have
 * the same authentication configuration for a GLBP group » : le hello
 * est **ecarte en silence**, pas refuse par une reponse.
 *
 * Le journal, lui, parle, et son texte est atteste :
 * `%GLBP-4-BADAUTH: Bad authentication received from [IP_address],
 * group [dec]`.
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

/** Deux routeurs IOS dans le meme groupe GLBP, sur un vrai cable. */
async function paire(
  lignesA: string[], lignesB: string[],
  ecouter?: (a: CiscoRouter, b: CiscoRouter) => void,
) {
  const a = new CiscoRouter(`A${++serie}`);
  const b = new CiscoRouter(`B${serie}`);
  ecouter?.(a, b);
  new Cable(`g${serie}`).connect(
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

const groupe = (r: CiscoRouter) =>
  [...r.getGlbpAgent().getConfig().groups.values()][0];

const VIP = 'glbp 1 ip 10.0.0.254';

describe('la cle atteint l\'agent, au lieu d\'etre jetee', () => {
  it('`authentication md5 key-string` est portee par le groupe', async () => {
    // Avant, ce `case` rendait la chaine vide sans rien ranger.
    const { a } = await paire(
      ['glbp 1 authentication md5 key-string LeSecret', VIP], []);
    expect(groupe(a).authMode).toBe('md5');
    expect(groupe(a).authKey).toBe('LeSecret');
  });

  it('`authentication text` est un mode DISTINCT, pas un md5 deguise', async () => {
    const { a } = await paire(['glbp 1 authentication text EnClair', VIP], []);
    expect(groupe(a).authMode).toBe('text');
    expect(groupe(a).authKey).toBe('EnClair');
  });

  it('`preempt delay minimum` atteint l\'agent lui aussi', async () => {
    // Elle n'etait pas meme analysee : la valeur disparaissait.
    const { a } = await paire([VIP, 'glbp 1 preempt delay minimum 25'], []);
    expect(groupe(a).preemptDelaySec).toBe(25);
  });
});

describe('deux cles differentes s\'ignorent', () => {
  it('memes cles : chacun voit l\'autre', async () => {
    // Le temoin, monte dans le meme laboratoire : sans lui, un labo mal
    // bati et une authentification cassee seraient indiscernables.
    const { a, b } = await paire(
      ['glbp 1 authentication md5 key-string LeSecret', VIP, 'glbp 1 priority 200'],
      ['glbp 1 authentication md5 key-string LeSecret', VIP, 'glbp 1 priority 100']);
    expect(groupe(a).avgIp).not.toBeNull();
    expect(groupe(b).avgIp).not.toBeNull();
  });

  it('cles DIFFERENTES : le hello est ecarte, donc le pair reste inconnu', async () => {
    const { b } = await paire(
      ['glbp 1 authentication md5 key-string CelleDeA', VIP, 'glbp 1 priority 200'],
      ['glbp 1 authentication md5 key-string CelleDeB', VIP, 'glbp 1 priority 100']);
    // `b` n'a jamais entendu `a` : il se croit donc seul et se declare
    // AVG, ce qui est exactement le symptome d'une discordance de cle.
    expect(groupe(b).avgIp).not.toBe('10.0.0.1');
  });

  it('modes DIFFERENTS : le desaccord de type est aussi un refus', async () => {
    const { b } = await paire(
      ['glbp 1 authentication md5 key-string LeSecret', VIP, 'glbp 1 priority 200'],
      ['glbp 1 authentication text LeSecret', VIP, 'glbp 1 priority 100']);
    expect(groupe(b).avgIp).not.toBe('10.0.0.1');
  });

  it('un groupe SANS authentification accepte un hello qui en porte une', async () => {
    // Meme regle que VRRP : le cote non configure doit VOIR l'asymetrie
    // plutot que de perdre les deux sens d'un coup.
    const { b } = await paire(
      ['glbp 1 authentication md5 key-string LeSecret', VIP, 'glbp 1 priority 200'],
      [VIP, 'glbp 1 priority 100']);
    expect(groupe(b).avgIp).toBe('10.0.0.1');
  });
});

describe('le refus se voit, et il nomme sa raison', () => {
  it('l\'evenement distingue le TYPE de la CLE', async () => {
    const motifs: string[] = [];
    await paire(
      ['glbp 1 authentication md5 key-string CelleDeA', VIP],
      ['glbp 1 authentication md5 key-string CelleDeB', VIP],
      (a, b) => {
        for (const r of [a, b]) {
          r.getBus().subscribe('glbp.auth.rejected',
            (e) => { motifs.push((e.payload as { reason: string }).reason); });
        }
      });
    expect(motifs).toContain('key');
    expect(motifs).not.toContain('type');
  });

  it('le journal porte le message d\'IOS, mot pour mot', async () => {
    const vus: string[] = [];
    Logger.subscribe((e) => { if (e.message.includes('BADAUTH')) vus.push(e.message); });
    await paire(
      ['glbp 1 authentication md5 key-string CelleDeA', VIP],
      ['glbp 1 authentication md5 key-string CelleDeB', VIP]);
    expect(vus.length).toBeGreaterThan(0);
    expect(vus[0]).toMatch(
      /^%GLBP-4-BADAUTH: Bad authentication received from \d+\.\d+\.\d+\.\d+, group 1$/);
  });

  it('sans discordance, aucun BADAUTH n\'est ecrit', async () => {
    // Un journal qui crierait au loup a chaque hello ne servirait a rien.
    const vus: string[] = [];
    Logger.subscribe((e) => { if (e.message.includes('BADAUTH')) vus.push(e.message); });
    await paire(
      ['glbp 1 authentication md5 key-string LeSecret', VIP],
      ['glbp 1 authentication md5 key-string LeSecret', VIP]);
    expect(vus).toHaveLength(0);
  });
});

describe('le delai de preemption GLBP retarde vraiment', () => {
  it('sans delai, le routeur prioritaire prend l\'AVG', async () => {
    const { a } = await paire(
      [VIP, 'glbp 1 priority 200', 'glbp 1 preempt'],
      [VIP, 'glbp 1 priority 100', 'glbp 1 preempt']);
    expect(groupe(a).avgState).toBe('active');
  });

  it('avec un delai, il attend', async () => {
    const { a } = await paire(
      ['glbp 1 preempt delay minimum 25', VIP, 'glbp 1 priority 200'],
      [VIP, 'glbp 1 priority 100', 'glbp 1 preempt']);
    expect(groupe(a).avgState).not.toBe('active');
  });

  it('et il prend l\'AVG une fois le delai passe', async () => {
    vi.useFakeTimers();
    try {
      const { a } = await paire(
        ['glbp 1 preempt delay minimum 25', VIP, 'glbp 1 priority 200'],
        [VIP, 'glbp 1 priority 100', 'glbp 1 preempt']);
      expect(groupe(a).avgState).not.toBe('active');
      await vi.advanceTimersByTimeAsync(26_000);
      expect(groupe(a).avgState).toBe('active');
    } finally { vi.useRealTimers(); }
  });
});
