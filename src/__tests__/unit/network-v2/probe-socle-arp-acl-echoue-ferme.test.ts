/*
 * Une faute de frappe dans une liste d'inspection ARP devenait un
 * PERMIT ANY ANY, et rien ne le disait.
 *
 *     (config-acl)# permit zorglub
 *     (config-acl)#
 *
 * Le gestionnaire de l'arbre ne refusait RIEN. Il cherchait `ip`, puis
 * `host`/`any`, puis `mac`, puis `host`/`any` ; tout mot qui ne tombait
 * pas a sa place etait simplement saute, et l'entree partait quand meme
 * au rangement avec ses deux criteres a `null` :
 *
 *     acl.entries.push({ action: kw, senderIp, senderMac,
 *                        raw: `${kw} ${args.join(' ')}`.trim() });
 *
 * Or `ArpInspectionEngine` lit `null` comme JOKER :
 *
 *     const ipMatch  = entry.senderIp  === null || entry.senderIp  === senderIp;
 *     const macMatch = entry.senderMac === null || entry.senderMac === senderMac;
 *
 * Donc `permit zorglub` laisse passer TOUTE trame ARP. C'est exactement
 * ce que la regle interdit : dans un moteur de filtrage, un critere que
 * le moteur ne sait pas trancher doit faire que l'entree NE
 * CORRESPOND PAS, sans quoi elle est plus permissive que ce que
 * l'operateur a ecrit. Ici elle est maximalement permissive, dans le
 * mecanisme meme qui protege le reseau de l'empoisonnement ARP.
 *
 * Six formes fautives etaient acceptees, mesurees avant correctif, et
 * toutes RENDUES par `show running-config` et par
 * `show arp access-list` — donc l'operateur qui relit sa configuration
 * y voit sa ligne, bien rangee, et la croit appliquee :
 *
 *     permit zorglub
 *     permit
 *     deny zorglub encore
 *     permit ip host 999.999.999.999 mac any
 *     permit ip host 10.0.0.1 mac host ZORGLUB
 *     permit ip host mac any          <- « host » sans adresse
 *
 * La cinquieme merite un mot : l'adresse MAC n'etait jamais analysee,
 * seulement mise en minuscules, donc `ZORGLUB` devenait le critere
 * `zorglub` — qui ne correspond a aucune trame. Celle-la echoue FERME,
 * par accident, la ou les autres echouent OUVERT.
 *
 * La septieme forme est d'une autre nature et le lot la refuse aussi :
 * `permit request ip any mac any` est une VRAIE forme d'IOS, mais le
 * mot `request` n'etait pas reconnu, donc l'analyse ne trouvait ni `ip`
 * ni `mac` a leur rang et rendait, la encore, un joker complet. Elle est
 * desormais DECLAREE — le mot est reconnu et les criteres qui le
 * suivent sont lus — ce qui la rend enfin fidele au lieu de la refuser.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. La grammaire declaree est donc celle que ce moteur EVALUE,
 * et que le gestionnaire documentait lui-meme :
 *
 *     permit ip {host <ip>|any} mac {host <mac>|any} [log]
 *
 * avec la variante `request`. Les formes plus longues d'IOS
 * (`response`, ses deux adresses et ses deux MAC) ne sont pas
 * sourcables d'ici ET ne sont pas evaluables par ce moteur : elles sont
 * REFUSEES plutot qu'acceptees en joker. C'est le choix que la regle
 * impose pour un critere de SECURITE, meme au prix d'une ligne qu'un
 * import de topologie ne saurait plus relire.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 9 des 19 cas
 * tombent — les sept refus, et les deux cas qui prouvent la
 * consequence, c'est-a-dire qu'une trame ARP quelconque n'est plus
 * laissee passer par une ligne fautive. Les 10 autres sont des
 * NON-REGRESSIONS : les cinq formes legitimes se posent, se relisent
 * dans les DEUX vues, et la porte `arp access-list` mene toujours a son
 * sous-mode. Sans eux, refuser tout ferait aussi passer la sonde.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

let serie = 0;

async function garde(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'arp access-list GARDE', ...prelude]) {
    await d.executeCommand(c);
  }
  return d;
}

async function configuration(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

type Moteur = {
  _getArpAccessLists(): Map<string, { name: string; entries: Array<{
    action: string; senderIp: string | null; senderMac: string | null;
  }> }>;
};

const entrees = (d: Cli) =>
  ((d as unknown as { d?: () => Moteur }).d?.() ?? (d as unknown as Moteur))
    ._getArpAccessLists().get('GARDE')?.entries ?? [];

describe('une liste ARP refuse ce qu\'elle ne sait pas evaluer', () => {
  describe('les formes fautives sont REFUSEES au caret', () => {
    it.each([
      'permit zorglub',
      'deny zorglub encore',
      'permit ip host 999.999.999.999 mac any',
      'permit ip host 10.0.0.1 mac host ZORGLUB',
      'permit ip host mac any',
      'permit response ip any any mac any any',
    ])('`%s`', async (ligne) => {
      const d = await garde();
      expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
    });

    it('`permit` nu est incomplet', async () => {
      const d = await garde();
      expect(await d.executeCommand('permit')).toMatch(/Incomplete command/);
    });
  });

  describe('la consequence : plus de joker pose par accident', () => {
    it('une ligne fautive ne laisse AUCUNE entree', async () => {
      const d = await garde('permit zorglub');
      expect(entrees(d), 'la ligne fautive a ete rangee').toHaveLength(0);
    });

    it('aucune entree ne porte deux criteres nuls par erreur', async () => {
      const d = await garde('permit ip host 10.0.0.1 mac any', 'permit zorglub');
      const jokers = entrees(d).filter(
        (e) => e.senderIp === null && e.senderMac === null);
      expect(jokers, 'un joker complet a ete pose').toHaveLength(0);
    });
  });

  describe('les formes legitimes passent — les TEMOINS', () => {
    it.each([
      'permit ip host 10.0.0.1 mac host 0011.2233.4455',
      'permit ip any mac any',
      'deny ip host 10.0.0.9 mac any',
      'permit ip host 10.0.0.1 mac any log',
      'permit request ip any mac any',
    ])('`%s` est accepte', async (ligne) => {
      const d = await garde();
      expect(await d.executeCommand(ligne), ligne).toBe('');
    });

    it('`permit ip any mac any` pose bien le joker DEMANDE', async () => {
      const d = await garde('permit ip any mac any');
      const [seule] = entrees(d);
      expect(seule?.senderIp).toBeNull();
      expect(seule?.senderMac).toBeNull();
    });

    it('les criteres nommes sont ranges', async () => {
      const d = await garde('permit ip host 10.0.0.1 mac host 0011.2233.4455');
      const [seule] = entrees(d);
      expect(seule?.senderIp).toBe('10.0.0.1');
      expect(seule?.senderMac).toBe('0011.2233.4455');
    });
  });

  describe('les deux vues disent la meme chose', () => {
    it('la ligne posee se relit dans running-config ET dans la vue', async () => {
      const d = await garde('permit ip host 10.0.0.1 mac host 0011.2233.4455');
      const vue = String(await d.executeCommand('do show arp access-list'));
      const cfg = await configuration(d);
      expect(cfg, 'absente de running-config')
        .toMatch(/permit ip host 10\.0\.0\.1 mac host 0011\.2233\.4455/);
      expect(vue, 'absente de la vue')
        .toMatch(/permit ip host 10\.0\.0\.1 mac host 0011\.2233\.4455/);
    });

    it('la porte `arp access-list` mene a son sous-mode — le TEMOIN', async () => {
      const d = await garde();
      expect(await d.executeCommand('permit ip any mac any')).toBe('');
      expect(String(await configuration(d))).toMatch(/arp access-list GARDE/);
    });

    it('`arp access-list` sans nom est incomplet', async () => {
      const d = await garde();
      await d.executeCommand('exit');
      expect(await d.executeCommand('arp access-list')).toMatch(/Incomplete command/);
    });
  });
});
