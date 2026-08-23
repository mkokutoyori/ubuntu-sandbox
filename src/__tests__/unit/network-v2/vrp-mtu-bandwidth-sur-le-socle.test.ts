/**
 * VRP : `mtu` et `bandwidth` avalaient un argument invalide.
 *
 * Mesure de depart, sur la vue d'interface d'un routeur Huawei —
 * `mtu zorglub` rendait la chaine VIDE, c'est-a-dire un succes, et ne
 * posait rien ; `mtu` seul de meme ; `mtu 1400 extra` posait 1400 et
 * jetait le mot en trop ; `undo mtu` et `undo bandwidth` etaient acceptes
 * et n'annulaient rien ; et `mtu ?` annoncait `WORD` la ou la commande
 * prend un entier borne. `speed zorglub` et `duplex zorglub`, declares
 * TROIS LIGNES plus bas dans le meme fichier, refusaient correctement :
 * la meme vue se contredisait sur ce qu'est un mauvais argument.
 *
 * La cause est la forme du gestionnaire : `registerGreedy` recoit des
 * mots et refait l'analyse a la main, donc `if (!isNaN(n))` ne pose rien
 * quand la conversion echoue — et ne dit rien non plus. C'est ce que le
 * socle (`src/cli/`) existe pour rendre impossible : l'argument est
 * DECLARE `INT` avec sa plage, donc l'analyseur refuse avant tout
 * gestionnaire, `?` annonce la vraie plage, et un mot en trop n'a nulle
 * part ou aller.
 *
 * Les deux commandes sont donc migrees vers le socle et RETIREES du trie
 * — les laisser aurait donne deux implementations, dont une morte.
 *
 * La forme d'annulation est declaree a part (`existsOnlyNegated`, le
 * mecanisme que `logging`'s `undoWithoutArgument` emploie deja) parce
 * qu'`undo mtu` ne prend PAS la valeur : la declarer sur la meme entree
 * ferait accepter `undo mtu 1400`, qu'un vrai VRP refuse.
 *
 * Corrige dans le PONT lui-meme, et c'etait un prealable : `VrpSocle.
 * diagnostic()` rendait `Unrecognized command` pour tout refus, alors que
 * l'analyseur distingue depuis toujours un mot-cle inconnu d'une valeur
 * refusee PAR UN ARGUMENT (`refusePar`), et que VRP dit
 * `Wrong parameter` dans le second cas. Le pont Cisco lisait deja ce
 * champ ; celui de VRP le jetait. Sans cela, migrer une famille a
 * argument type aurait echange une reponse fausse contre une autre.
 * Meme raison pour l'aide : `suggestions()` filtrait les arguments, donc
 * une commande dont la suite est un ARGUMENT et non un mot-cle rendait
 * une liste vide, c'est-a-dire `Error: Unrecognized command` sur un `?`.
 *
 * **Le COMMUTATEUR passe au socle en meme temps**, et c'est la raison
 * pour laquelle son pont est ecrit ici plutot que reporte : sans lui, les
 * deux plateformes VRP auraient repondu differemment a la meme commande —
 * `undo mtu` inerte d'un cote et actif de l'autre, `mtu ?` annoncant
 * `WORD` ici et `<68-9216>` la. `VRP_SWITCH_MODES` decrit la hierarchie
 * de vues que `VUES_SWITCH` enumerait deja sans dire leurs parents, et
 * `VrpSocle` prend desormais sa hierarchie en parametre.
 *
 * Le commutateur ne recoit QUE `mtu` : `bandwidth` n'etait pas dans son
 * vocabulaire, et le lui donner « puisque la famille est la » aurait
 * invente une commande sur une plateforme dont rien n'atteste qu'elle la
 * porte. La famille est donc scindee en deux, chaque plateforme prenant
 * ce qu'elle avait.
 *
 * Discrimine par `git stash` des fichiers touches : 9 des 11 cas tombent.
 * Les 3 qui passent des deux cotes sont nommes ici plutot que laisses a
 * decouvrir — le TEMOIN `speed zorglub`, dont c'est l'objet (il refusait
 * deja, et sans lui « la commande refuse » ne distinguerait pas un
 * correctif d'une vue qui refuse tout), et les deux cas de pose
 * nominale, qui marchaient et servent de non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

async function surInterface(): Promise<{ r: HuaweiRouter; nom: string }> {
  const r = new HuaweiRouter('R1');
  r.powerOn();
  const nom = r.getPorts()[0].getName();
  await r.executeCommand('system-view');
  await r.executeCommand(`interface ${nom}`);
  return { r, nom };
}

const mtu = (r: HuaweiRouter) => r.getPorts()[0].getMTU();
const bw = (r: HuaweiRouter) => r.getPorts()[0].getBandwidthKbps();

describe('VRP : un argument borne est refuse par l analyseur', () => {
  it('TEMOIN — `speed zorglub` refusait deja', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('speed zorglub')).toContain('Wrong parameter');
  });

  it('`mtu zorglub` est refuse et ne pose rien', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('mtu zorglub')).toContain('Wrong parameter');
    expect(mtu(r)).toBe(1500);
  });

  it('`mtu` seul est incomplete', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('mtu')).toContain('Incomplete command');
  });

  it('un mot en trop est refuse au lieu d etre jete', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('mtu 1400 extra')).toContain('Error:');
    expect(mtu(r)).toBe(1500);
  });

  it('une valeur hors plage est refusee par l analyseur', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('mtu 99999')).toContain('Wrong parameter');
    expect(mtu(r)).toBe(1500);
  });

  it('`bandwidth zorglub` est refuse et ne pose rien', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('bandwidth zorglub')).toContain('Wrong parameter');
    expect(bw(r)).toBe(0);
  });

  it('une valeur valide est posee, et rendue', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('mtu 1400')).toBe('');
    expect(await r.executeCommand('bandwidth 64')).toBe('');

    expect(mtu(r)).toBe(1400);
    expect(bw(r)).toBe(64);
    const vue = await r.executeCommand('display this');
    expect(vue).toContain(' mtu 1400');
    expect(vue).toContain(' bandwidth 64');
  });

  it('`undo mtu` restaure le defaut', async () => {
    const { r } = await surInterface();
    await r.executeCommand('mtu 1400');

    expect(await r.executeCommand('undo mtu')).toBe('');

    expect(mtu(r)).toBe(1500);
  });

  it('`undo bandwidth` rend la bande passante au lien', async () => {
    const { r } = await surInterface();
    await r.executeCommand('bandwidth 64');

    expect(await r.executeCommand('undo bandwidth')).toBe('');

    expect(bw(r)).toBe(0);
  });

  it('`undo mtu 1400` est refuse — l annulation ne prend pas la valeur', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('undo mtu 1400')).toContain('Error:');
  });

  it('`?` annonce la plage et non un mot', async () => {
    const { r } = await surInterface();

    expect(await r.executeCommand('mtu ?')).toContain('<68-9216>');
    expect(await r.executeCommand('bandwidth ?')).toContain('<1-4294967295>');
  });
});

async function surInterfaceCommutateur(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW');
  sw.powerOn();
  await sw.executeCommand('system-view');
  await sw.executeCommand(`interface ${sw.getPorts()[0].getName()}`);
  return sw;
}

describe('VRP : le commutateur repond comme le routeur', () => {
  it('`undo mtu` restaure le defaut, comme sur le routeur', async () => {
    const sw = await surInterfaceCommutateur();
    await sw.executeCommand('mtu 1400');

    expect(await sw.executeCommand('undo mtu')).toBe('');

    expect(sw.getPorts()[0].getMTU()).toBe(1500);
  });

  it('`mtu ?` annonce la meme plage que sur le routeur', async () => {
    const sw = await surInterfaceCommutateur();

    expect(await sw.executeCommand('mtu ?')).toContain('<68-9216>');
  });

  it('`mtu` seul est incomplete, et non un mauvais parametre', async () => {
    const sw = await surInterfaceCommutateur();

    expect(await sw.executeCommand('mtu')).toContain('Incomplete command');
  });

  it('la valeur posee est toujours rendue par `display this`', async () => {
    const sw = await surInterfaceCommutateur();
    await sw.executeCommand('mtu 1400');

    expect(await sw.executeCommand('display this')).toContain(' mtu 1400');
  });

  it('`bandwidth` reste inconnue du commutateur', async () => {
    const sw = await surInterfaceCommutateur();

    expect(await sw.executeCommand('bandwidth 64')).toContain('Unrecognized command');
  });
});
