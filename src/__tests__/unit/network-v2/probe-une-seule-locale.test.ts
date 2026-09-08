/**
 * Une machine a UNE locale, et toutes ses vues la disent.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire :
 *
 * ```
 * cat /etc/default/locale   LANG=en_US.UTF-8
 * SystemIdentity.locale     en_US.UTF-8
 * locale                    LANG=            LC_CTYPE="C"
 * echo $LANG                (vide)
 * localectl                 localectl: command not found
 * ```
 *
 * Le fichier et l'identite s'accordent ; l'ENVIRONNEMENT et `locale`
 * disent autre chose, et la commande qui arbitre n'existe pas. Une
 * machine dont `/etc/default/locale` annonce `en_US.UTF-8` pendant que
 * `locale` repond `C` est une machine qui se contredit, et c'est la
 * forme de defaut que ce depot ferme partout ailleurs.
 *
 * La consequence est concrete : sur une vraie Ubuntu, PAM exporte
 * `LANG` depuis `/etc/default/locale` a l'ouverture de session. Tout ce
 * qui lit `$LANG` — un script, un `date`, un message d'erreur traduit —
 * part donc du bon reglage. Ici il partait de rien.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Les intitules de `localectl status` sont EXTRAITS du binaire
 * `/usr/bin/localectl` livre sur la machine qui execute ce depot
 * (`System Locale`, `VC Keymap`, `VC Toggle Keymap`, `X11 Layout`,
 * `X11 Model`, `X11 Variant`, `X11 Options`), et les refus viennent de
 * `src/locale/localed.c` de systemd, lu a la source :
 *
 * ```
 * Locale %s not installed, refusing.
 * Locale assignment %s not valid, refusing.
 * Specified locale is not installed: %s
 * ```
 *
 * Le client les prefixe de `Failed to issue method call: `, template
 * lui aussi extrait du binaire.
 *
 * ── Un cas ecrit a l'aveugle etait FAUX, et la source l'a tranche ──
 *
 * Il exigeait `VC Keymap: us`. Sur une Debian, le clavier est declare
 * dans `/etc/default/keyboard` (XKBLAYOUT), pas dans la console
 * virtuelle : `localectl` rend donc le clavier sous `X11 Layout`, et
 * `VC Keymap` reste vide. Vide, la table verticale de systemd ecrit
 * `(unset)` — `TABLE_ERSATZ_UNSET` de `src/shared/format-table.c`, lu a
 * la source plutot que devine. Le cas verifie desormais les deux.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 9 cas sur 12 tombent contre l'etat d'avant. Les TROIS
 * autres sont les TEMOINS, et c'est leur role : `/etc/default/locale`,
 * qui etait deja juste et dont on part ; `hostnamectl`, la vue soeur de
 * la meme identite, dont l'alignement sert de modele a `localectl` et
 * qui ne doit pas bouger ; et le droit de veto de `LC_ALL`, qui passait
 * deja et qui doit survivre au fait que `LANG` cesse d'etre vide.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Cmd {
  return createDevice('linux-pc', 0, 0) as unknown as Cmd;
}

describe('la locale de la machine est celle que tout le monde lit', () => {
  it('locale rend celle du fichier, pas C', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('locale');

    expect(sortie).toMatch(/^LANG=en_US\.UTF-8$/m);
    expect(sortie).toMatch(/^LC_CTYPE="en_US\.UTF-8"$/m);
  });

  it('l environnement du shell la porte', async () => {
    const pc = poste();

    expect((await pc.executeCommand('echo $LANG')).trim()).toBe('en_US.UTF-8');
  });

  it('localectl status la rend avec le clavier', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('localectl status');

    expect(sortie).toMatch(/System Locale: LANG=en_US\.UTF-8/);
    expect(sortie).toMatch(/VC Keymap: \(unset\)/);
    expect(sortie).toMatch(/X11 Layout: us/);
  });

  it('localectl sans verbe vaut status', async () => {
    const pc = poste();

    expect(await pc.executeCommand('localectl')).toContain('System Locale: LANG=en_US.UTF-8');
  });

  it('list-locales ne rend que celles qui sont installees', async () => {
    const pc = poste();

    const liste = (await pc.executeCommand('localectl list-locales')).trim().split('\n');

    expect(liste).toContain('en_US.UTF-8');
    expect(liste).toContain('C.UTF-8');
    expect(liste).not.toContain('fr_FR.UTF-8');
  });
});

describe('set-locale change la machine, pas une vue seule', () => {
  it('les quatre vues suivent ensemble', async () => {
    const pc = poste();

    await pc.executeCommand('sudo localectl set-locale LANG=C.UTF-8');

    expect(await pc.executeCommand('localectl')).toContain('System Locale: LANG=C.UTF-8');
    expect(await pc.executeCommand('cat /etc/default/locale')).toContain('LANG=C.UTF-8');
    expect(await pc.executeCommand('locale')).toMatch(/^LANG=C\.UTF-8$/m);
    expect((await pc.executeCommand('echo $LANG')).trim()).toBe('C.UTF-8');
  });

  it('une locale absente de la machine est REFUSEE', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('sudo localectl set-locale LANG=fr_FR.UTF-8');

    expect(sortie).toContain('Failed to issue method call: Locale fr_FR.UTF-8 not installed, refusing.');
    expect(await pc.executeCommand('locale')).toMatch(/^LANG=en_US\.UTF-8$/m);
  });

  it('une affectation qui n est pas une variable de locale est REFUSEE', async () => {
    const pc = poste();

    expect(await pc.executeCommand('sudo localectl set-locale ZORGLUB=1'))
      .toContain('Failed to issue method call: Locale assignment ZORGLUB=1 not valid, refusing.');
  });

  it('un nom seul est pris pour LANG, et refuse s il n est pas la', async () => {
    const pc = poste();

    expect(await pc.executeCommand('sudo localectl set-locale zorglub'))
      .toContain('Failed to issue method call: Specified locale is not installed: zorglub');
  });
});

describe('TEMOINS', () => {
  it('/etc/default/locale etait deja juste et le reste', async () => {
    const pc = poste();

    expect(await pc.executeCommand('cat /etc/default/locale')).toContain('LANG=en_US.UTF-8');
  });

  it('hostnamectl, la vue soeur, ne bouge pas', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('hostnamectl');

    expect(sortie).toContain('Static hostname: linux-pc');
    expect(sortie).toContain('Operating System: Ubuntu 22.04.4 LTS');
  });

  it('LC_ALL garde son droit de veto', async () => {
    const pc = poste();

    expect(await pc.executeCommand('LC_ALL=C locale')).toMatch(/^LC_CTYPE="C"$/m);
  });
});
