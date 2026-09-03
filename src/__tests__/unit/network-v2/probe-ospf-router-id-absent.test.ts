/**
 * Un processus OSPF ne tourne JAMAIS sous l'identifiant 0.0.0.0, et il
 * DIT pourquoi il ne demarre pas.
 *
 * Question posee sur transcription : « est-ce normal que la table de
 * routage soit vide alors qu'on a configure OSPF ? ». Elle l'etait —
 * aucune interface ne portait d'adresse, donc pas de route connectee,
 * et `network 10.0.0.0 0.0.0.255 area 0` ne selectionnait aucune
 * interface. Mais la machine ne le DISAIT nulle part : un vrai IOS
 * ecrit dans son journal, des l'entree dans `router ospf`,
 * `%OSPF-4-NORTRID: OSPF process 1 failed to allocate unique router-id
 * and cannot start`. C'est cette ligne qui repond a la question sur la
 * machine elle-meme.
 *
 * **Un second defaut, plus grave, a ete trouve en mesurant le premier.**
 * L'identifiant etait elu une seule fois, a l'entree dans `router ospf`,
 * et jamais rejoue. Dans l'ordre que tout le monde tape — le processus
 * d'abord, les adresses ensuite — aucune interface n'etait encore
 * utilisable a cet instant, donc le moteur demarrait SANS identifiant :
 * mesure, il formait ensuite une vraie adjacence, apprenait de vraies
 * routes et annoncait ses LSA sous 0.0.0.0, que `show ip protocols`
 * affichait tel quel. `OSPFEngine.setRouterId` REFUSE pourtant cette
 * valeur en citant la RFC 2328 — le moteur savait donc qu'elle est
 * invalide, et la portait quand meme parce que c'est son defaut de
 * construction. `0.0.0.0` n'est pas un identifiant, c'est le mot pour
 * dire qu'il n'y en a pas, et il ne s'ecrit plus qu'a un seul endroit.
 *
 * L'election est rejouee tant qu'il n'y en a pas, au debut de la
 * convergence — donc avant qu'une seule interface soit activee, et
 * avant qu'un Hello parte sous un identifiant nul. Un `router-id` pose
 * a la main n'est jamais touche.
 *
 * Discrimine par `git stash push` : 6 des 12 cas tombent, et les 6
 * autres sont nommes ici plutot que laisses a decouvrir. « la table est
 * vide sans adresse » est le TEMOIN qui repond a la question posee, et
 * dont c'est l'objet de passer des deux cotes. « ne dit rien quand une
 * interface est deja utilisable » passait a VIDE, aucun message
 * n'existant avant correctif ; il garde desormais que le message ne part
 * pas a tort. « converge quand meme » passait parce que la convergence
 * avait bel et bien lieu — sous 0.0.0.0, ce qui est justement le defaut,
 * donc ce cas garde que le correctif ne l'a pas cassee. Et les trois
 * derniers gardent la regle d'election, qui etait deja juste : un
 * `router-id` manuel n'est pas ecrase, la boucle l'emporte sur le port
 * physique, et un identifiant deja alloue ne bouge plus — ce dernier a
 * corrige une attente FAUSSE de ma part, creer une boucle APRES
 * l'allocation ne deplace pas l'identifiant sur un vrai IOS, il faut
 * `clear ip ospf process`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

async function taper(r: CiscoRouter, ...lignes: string[]): Promise<string> {
  let derniere = '';
  for (const ligne of lignes) derniere = await r.executeCommand(ligne);
  return derniere;
}

const NORTRID = '%OSPF-4-NORTRID: OSPF process 1 failed to allocate unique '
  + 'router-id and cannot start';

async function sansAdresse(nom = 'Router1'): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom, 0, 0);
  await taper(r, 'enable', 'configure terminal', 'router ospf 1',
    'network 10.0.0.0 0.0.0.255 area 0', 'end');
  return r;
}

function routerId(texte: string): string {
  return /Router ID (\S+)/.exec(texte)?.[1] ?? '';
}

describe('OSPF sans identifiant de routeur', () => {
  it('ecrit `%OSPF-4-NORTRID` avec le texte d\'IOS', async () => {
    const r = await sansAdresse();
    expect(await r.executeCommand('show logging')).toContain(NORTRID);
  });

  it('TEMOIN : la table est vide sans adresse, et c\'est normal', async () => {
    const r = await sansAdresse();
    const table = await r.executeCommand('show ip route');
    expect(table).toContain('Gateway of last resort is not set');
    expect(table).not.toMatch(/^C\s/m);
    expect(await r.executeCommand('show ip route ospf')).not.toMatch(/^O\s/m);
  });

  it('ne dit rien quand une interface est deja utilisable', async () => {
    const r = new CiscoRouter('Router2', 0, 0);
    const v = new CiscoRouter('Voisin', 200, 0);
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);
    await taper(r, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit', 'router ospf 1',
      'network 10.0.0.0 0.0.0.255 area 0', 'end');

    expect(await r.executeCommand('show logging')).not.toContain('NORTRID');
  });

  it('n\'annonce pas 0.0.0.0 comme identifiant une fois l\'interface montee',
    async () => {
      const r = await sansAdresse();
      const v = new CiscoRouter('Voisin', 200, 0);
      await taper(v, 'enable', 'configure terminal',
        'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
        'no shutdown', 'exit', 'router ospf 1',
        'network 10.0.0.0 0.0.0.255 area 0', 'end');
      await taper(r, 'configure terminal', 'interface GigabitEthernet0/0',
        'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
      new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
        v.getPort('GigabitEthernet0/0')!);

      const id = routerId(await r.executeCommand('show ip protocols'));
      expect(id).not.toBe('0.0.0.0');
      expect(id).toBe('10.0.0.1');
    });

  it('`show ip ospf` rend le meme identifiant', async () => {
    const r = await sansAdresse();
    const v = new CiscoRouter('Voisin', 200, 0);
    await taper(v, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
      'no shutdown', 'exit', 'router ospf 1',
      'network 10.0.0.0 0.0.0.255 area 0', 'end');
    await taper(r, 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);

    expect(await r.executeCommand('show ip ospf')).toContain('with ID 10.0.0.1');
  });

  it('le voisin ne voit jamais un voisin a 0.0.0.0', async () => {
    const r = await sansAdresse();
    const v = new CiscoRouter('Voisin', 200, 0);
    await taper(v, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
      'no shutdown', 'exit', 'router ospf 1',
      'network 10.0.0.0 0.0.0.255 area 0', 'end');
    await taper(r, 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);
    await r.executeCommand('show ip route');

    const voisins = await v.executeCommand('show ip ospf neighbor');
    expect(voisins).toContain('10.0.0.1');
    expect(voisins).not.toContain('0.0.0.0');
  });

  it('converge quand meme : adjacence et route apprise', async () => {
    const r = await sansAdresse();
    const v = new CiscoRouter('Voisin', 200, 0);
    await taper(v, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
      'no shutdown', 'exit', 'interface GigabitEthernet0/1',
      'ip address 192.168.9.1 255.255.255.0', 'no shutdown', 'exit',
      'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0',
      'network 192.168.9.0 0.0.0.255 area 0', 'end');
    await taper(r, 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);

    expect(await r.executeCommand('show ip route ospf'))
      .toContain('192.168.9.0/24');
  });

  it('un router-id manuel n\'est pas ecrase', async () => {
    const r = new CiscoRouter('Router3', 0, 0);
    const v = new CiscoRouter('Voisin', 200, 0);
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);
    await taper(r, 'enable', 'configure terminal', 'router ospf 1',
      'router-id 9.9.9.9', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'end');

    expect(routerId(await r.executeCommand('show ip protocols'))).toBe('9.9.9.9');
  });

  it('la boucle l\'emporte sur le port physique', async () => {
    const r = new CiscoRouter('Router4', 0, 0);
    const v = new CiscoRouter('Voisin', 200, 0);
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);
    await taper(r, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit', 'interface Loopback0',
      'ip address 1.1.1.1 255.255.255.255', 'exit',
      'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end');

    expect(routerId(await r.executeCommand('show ip protocols'))).toBe('1.1.1.1');
  });

  it('un identifiant deja alloue ne change plus, comme sur IOS', async () => {
    const r = new CiscoRouter('Router6', 0, 0);
    const v = new CiscoRouter('Voisin', 200, 0);
    new Cable('l').connect(r.getPort('GigabitEthernet0/0')!,
      v.getPort('GigabitEthernet0/0')!);
    await taper(r, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit', 'router ospf 1',
      'network 10.0.0.0 0.0.0.255 area 0', 'exit',
      'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'end');

    expect(routerId(await r.executeCommand('show ip protocols'))).toBe('10.0.0.1');
  });

  it('nomme le numero de processus dans son message', async () => {
    const r = new CiscoRouter('Router5', 0, 0);
    await taper(r, 'enable', 'configure terminal', 'router ospf 42',
      'network 10.0.0.0 0.0.0.255 area 0', 'end');

    expect(await r.executeCommand('show logging'))
      .toContain('OSPF process 42 failed to allocate unique router-id');
  });

  it('classe le message en severite 4', async () => {
    const r = await sansAdresse();
    expect(await r.executeCommand('show logging | include NORTRID'))
      .toMatch(/%OSPF-4-NORTRID/);
  });
});
