/*
 * Le sous-mode des listes IPv6 nommees quitte l'arbre EN ENTIER.
 *
 * `config-ipv6-nacl` etait le plus gros arbre encore executable du
 * routeur : six chemins, tous gloutons — `permit`, `deny`, `sequence`,
 * `no`, `remark`, `evaluate`. Il est desormais vide, et la sonde
 * l'exige explicitement, parce que c'est le but du chantier et non un
 * effet de bord.
 *
 * Une migration ne doit RIEN perdre, et c'est la moitie du travail.
 * Avant de deplacer quoi que ce soit, 48 lignes ont ete jouees contre
 * l'arbre et leur reponse relevee — la sortie de la commande ET le bloc
 * rendu par `show running-config`. Apres migration, les 48 sont
 * identiques au caractere pres. Ce releve couvre ce qui passe
 * (`permit tcp 2001:db8::/64 any range 100 200`), ce qui est refuse au
 * caret (`permit zorglub any any`, `permit ipv6 2001:db8::/129 any`),
 * ce qui est incomplet (`permit ipv6 any`), et les refus qui dependent
 * du SENS (`reflect` n'existe qu'en `permit`, `undetermined-transport`
 * qu'en `deny`) ou du PROTOCOLE (`established` et les ports n'existent
 * que sur tcp/udp/sctp).
 *
 * Ce que la migration APPORTE, et que le glouton ne pouvait pas donner :
 * l'aide annonce le TYPE attendu a chaque place. `permit tcp ?` disait
 * seulement ce que le gestionnaire laissait deviner ; il annonce
 * maintenant `X:X:X:X::X/<0-128>` pour le prefixe, et les bornes des
 * places numeriques sont appliquees parce qu'elles sont declarees.
 *
 * Le port `ipv6AclHost` reprend TELS QUELS l'analyseur (`parseIpv6Ace`),
 * le rangement et les refus du glouton : le socle pilote exactement ce
 * que l'arbre pilotait. `aclSubmodeSpecs`, qui portait deja `remark`,
 * `evaluate` et la suppression par numero pour les listes v4, sert
 * maintenant les trois sous-modes — une declaration, trois lecteurs.
 *
 * UN DEFAUT MESURE ET NON CORRIGE ICI, parce qu'il n'appartient pas a
 * ce lot : un mot-cle declare comme simple pas de chemin herite de la
 * description de sa COMMANDE. `permit ?` annonce donc
 * « icmp  Specify packets to forward » au lieu du nom du protocole, et
 * de meme pour `any`, `host` et les operateurs de port. Ce n'est pas
 * une regression de cette migration : la famille IPv4 etendue, migree
 * avant elle, rend exactement la meme chose — c'est verifie. Le
 * corriger demande de donner une description a un pas de chemin, au
 * niveau du socle, et profiterait aux deux familles d'un coup. Le faire
 * ici ne reparerait qu'IPv6 et laisserait les deux vues en desaccord.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau ; la sonde n'invente donc aucune forme. Elle exige que la
 * grammaire deja servie soit servie a l'identique, et que l'arbre soit
 * vide.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 3 des 22 cas
 * tombent — l'arbre vide, et les deux annonces de type que le glouton
 * ne faisait pas. Les 19 autres passent DES DEUX COTES, et c'est tout
 * le resultat : ils prouvent que rien de la grammaire n'a bouge. Une
 * sonde de migration dont tous les cas tomberaient signalerait un
 * changement de comportement, c'est-a-dire l'echec de la migration.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

type AvecArbre = {
  getActiveTrie(): { enumerateExecutablePaths(): string[] };
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m);

let serie = 0;

async function liste(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`R${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'ipv6 access-list L', ...prelude]) {
    await d.executeCommand(c);
  }
  return d;
}

async function configuration(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

describe('le sous-mode IPv6 est servi par le socle', () => {
  it('l\'arbre `config-ipv6-nacl` est VIDE — le but du chantier', async () => {
    const d = await liste();
    const shell = ((d as unknown as { shell?: AvecArbre }).shell ?? (d as unknown as AvecArbre));
    expect(shell.getActiveTrie().enumerateExecutablePaths()).toEqual([]);
  });

  describe('l aide annonce le TYPE, ce que le glouton ne faisait pas', () => {
    it('`permit tcp ?` annonce le prefixe source', async () => {
      const d = await liste();
      expect(nomsAnnonces(d.cliHelp('permit tcp '))).toContain('X:X:X:X::X/<0-128>');
    });

    it('`sequence ?` annonce sa plage', async () => {
      const d = await liste();
      expect(nomsAnnonces(d.cliHelp('sequence '))).toContain('<1-2147483647>');
    });
  });

  describe('la grammaire est servie a l identique — les TEMOINS', () => {
    it.each([
      'permit ipv6 any any',
      'deny ipv6 any any',
      'permit tcp any any eq 80',
      'permit tcp any eq 1024 any',
      'permit tcp 2001:db8::/64 any range 100 200',
      'permit icmp any any echo-request',
      'permit tcp any any established',
      'permit ipv6 any any log',
      'permit ipv6 any any reflect MIROIR',
      'deny ipv6 any any undetermined-transport',
      'permit ipv6 host 2001:db8::1 host 2001:db8::2',
    ])('`%s` est accepte', async (ligne) => {
      const d = await liste();
      expect(await d.executeCommand(ligne), ligne).toBe('');
    });

    it.each([
      'permit zorglub any any',
      'permit ipv6 any any zorglub',
      'permit ipv6 2001:db8::/129 any',
      'permit udp any any established',
      'deny ipv6 any any reflect MIROIR',
      'permit ipv6 any any undetermined-transport',
    ])('`%s` est refuse au caret', async (ligne) => {
      const d = await liste();
      expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
    });
  });

  describe('ce qui se pose se relit', () => {
    it('une entree, une remarque et un renvoi se relisent', async () => {
      const d = await liste(
        'permit tcp 2001:db8::/64 any eq 22',
        'remark porte de gestion',
        'evaluate MIROIR');
      const cfg = await configuration(d);
      expect(cfg, 'l entree ne se relit pas')
        .toMatch(/permit tcp 2001:db8::\/64 any eq ssh/);
      expect(cfg, 'la remarque ne se relit pas').toMatch(/remark porte de gestion/);
      expect(cfg, 'le renvoi ne se relit pas').toMatch(/evaluate MIROIR/);
    });

    /*
     * La frappe porte le numero EN TETE et la configuration le rend en
     * QUEUE : c'est la convention d'IOS pour les listes IPv6, et celle
     * que ce depot servait deja avant la migration.
     */
    it('`sequence 50 permit ipv6 any any` garde son numero', async () => {
      const d = await liste('sequence 50 permit ipv6 any any');
      expect(await configuration(d)).toMatch(/permit ipv6 any any sequence 50/);
    });
  });
});
