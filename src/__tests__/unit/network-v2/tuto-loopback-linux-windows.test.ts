/**
 * Le tutoriel « Les Interfaces Loopback », parties Linux et Windows.
 *
 * Ce que la mesure a trouvé, et que ces cas tiennent :
 *
 * **`lo` était une fiction de rendu.** `getInterfaceInfo('lo')`
 * fabriquait un objet quand on le lui demandait, sans qu'aucun port
 * n'existe derrière : `ip link show lo` décrivait la boucle pendant que
 * `ip addr add 10.0.0.1/32 dev lo` — le laboratoire entier de la partie
 * Linux — répondait `Cannot find device "lo"` sur la même machine au
 * même instant. C'est un vrai port désormais, créé au démarrage comme
 * le noyau le fait.
 *
 * **Le rendu ne correspondait pas à un vrai `ip`**, mesuré contre
 * `iproute2` installé : `state UP` au lieu de `UNKNOWN`, pas de
 * `qlen 1000`, un `brd 127.255.255.255` que `ip` n'imprime pas, et
 * `valid_lft` absent de TOUTES les adresses IPv4 — pas seulement celles
 * de la boucle.
 *
 * **Une interface `dummy` sortait `<NO-CARRIER,…> state DOWN`** alors
 * que le vrai Linux écrit `<BROADCAST,NOARP,UP,LOWER_UP> state
 * UNKNOWN`, et `ip link set … up` ne changeait rien à ce qu'on lisait.
 *
 * **Une adresse secondaire n'était joignable par personne**, y compris
 * par la machine qui la portait : seule l'adresse PRIMAIRE d'un port
 * produisait une route et seule elle était reconnue comme « à nous ».
 * Ce n'est pas propre à la boucle — c'était vrai de toute adresse
 * ajoutée par `ip addr add`, sur n'importe quelle interface.
 *
 * **`modprobe` n'existait pas** sur une machine où
 * `ip link add … type dummy` fonctionne, c'est-à-dire où le module EST
 * disponible.
 *
 * **Côté Windows**, `route print` sortait une table `Active Routes:`
 * VIDE sur un poste fraîchement démarré, pendant que `Get-NetRoute` en
 * déclarait une, écrite en dur — et un troisième exemplaire, avec une
 * autre métrique, vivait dans le fournisseur PowerShell. Trois vues de
 * la même table, trois réponses.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { pingOnSimulatedClock } from '../../support/fastPing';

async function sh(pc: LinuxPC, cmd: string): Promise<string> {
  return String(await pc.executeCommand(cmd));
}

// ── Linux, partie 5 du tutoriel ──────────────────────────────────────

describe('Linux : l\'interface lo est un vrai port', () => {
  it('`ip link show lo` rend ce qu\'un vrai iproute2 rend', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    const out = await sh(pc, 'ip link show lo');
    expect(out).toContain('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536');
    expect(out).toContain('qdisc noqueue');
    // Mesurés sur `iproute2` installé : l'état d'une interface dont la
    // porteuse n'est pas une question, et la longueur de file que `lo`
    // porte comme les autres.
    expect(out).toContain('state UNKNOWN');
    expect(out).toContain('qlen 1000');
    expect(out).toContain('link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00');
  });

  it('`ip addr show lo` ne met pas de broadcast sur 127.0.0.1 et date ses adresses', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    const out = await sh(pc, 'ip addr show lo');
    expect(out).toContain('inet 127.0.0.1/8 scope host lo');
    expect(out).not.toContain('brd 127.255.255.255');
    expect(out).toContain('valid_lft forever preferred_lft forever');
    // `::1` est de portée HOST : elle ne quitte pas la machine.
    expect(out).toContain('inet6 ::1/128 scope host');
    // Et une boucle n'a pas d'adresse de lien : il n'y a pas de lien.
    expect(out).not.toMatch(/inet6 fe80:/);
  });

  it('`valid_lft` figure aussi sur une interface physique — les deux familles se décrivent pareil', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    await sh(pc, 'sudo ip addr add 192.0.2.10/24 dev eth0');
    const out = await sh(pc, 'ip addr show eth0');
    expect(out).toContain('inet 192.0.2.10/24');
    expect(out).toContain('valid_lft forever preferred_lft forever');
  });

  /** Le laboratoire central de la partie 5. */
  it('on ajoute et retire une adresse sur lo, et elle répond', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');

    expect(await sh(pc, 'sudo ip addr add 10.0.0.1/32 dev lo')).not.toContain('Cannot find device');
    const apres = await sh(pc, 'ip addr show lo');
    expect(apres).toContain('inet 10.0.0.1/32');
    // Une adresse posée sur la boucle est là pour être ANNONCÉE : sa
    // portée est globale, celle de 127.0.0.1 seule est `host`.
    expect(apres).toContain('scope global');

    const ping = await sh(pc, 'ping -c 2 10.0.0.1');
    expect(ping).toContain('2 received');
    expect(ping).not.toContain('Network is unreachable');

    await sh(pc, 'sudo ip addr del 10.0.0.1/32 dev lo');
    expect(await sh(pc, 'ip addr show lo')).not.toContain('10.0.0.1');
  });

  it('plusieurs adresses cohabitent sur lo', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    for (const a of ['192.168.1.1/24', '192.168.2.1/24', '192.168.3.1/24']) {
      await sh(pc, `sudo ip addr add ${a} dev lo`);
    }
    const out = await sh(pc, 'ip addr show lo');
    for (const a of ['192.168.1.1/24', '192.168.2.1/24', '192.168.3.1/24']) {
      expect(out, a).toContain(a);
    }
    expect(await sh(pc, 'ping -c 1 192.168.2.1')).toContain('1 received');
  });

  it('`ping 127.0.0.1` et `ping ::1` répondent', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    expect(await sh(pc, 'ping -c 2 127.0.0.1')).toContain('2 received');
    expect(await sh(pc, 'ping -c 2 ::1')).toContain('2 received');
  });

  /** Le noyau la crée et personne ne la supprime. */
  it('`ip link del lo` est refusé', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    expect(await sh(pc, 'sudo ip link del lo')).toContain('Operation not permitted');
    expect(await sh(pc, 'ip link show lo')).toContain('1: lo:');
  });

  it('`ip -br addr` rapporte le même état que la vue longue', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    expect(await sh(pc, 'ip -br addr')).toMatch(/^lo\s+UNKNOWN\s+127\.0\.0\.1\/8/m);
  });
});

describe('Linux : l\'interface dummy, la vraie loopback supplémentaire', () => {
  it('elle naît avec les fanions d\'un vrai dummy, pas ceux d\'une carte débranchée', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    await sh(pc, 'sudo ip link add lo1 type dummy');
    await sh(pc, 'sudo ip addr add 10.0.0.1/32 dev lo1');
    await sh(pc, 'sudo ip link set lo1 up');

    const out = await sh(pc, 'ip addr show lo1');
    expect(out).toContain('<BROADCAST,NOARP,UP,LOWER_UP>');
    expect(out).toContain('state UNKNOWN');
    expect(out).toContain('qdisc noqueue');
    expect(out).not.toContain('NO-CARRIER');
    // Sur une dummy, l'adresse est globalement joignable — c'est ce qui
    // la distingue d'une adresse posée sur `lo`, et le §8 du tutoriel.
    expect(out).toContain('inet 10.0.0.1/32 scope global lo1');
  });

  it('elle répond, puis disparaît avec `ip link del`', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    await sh(pc, 'sudo ip link add dummy0 type dummy');
    await sh(pc, 'sudo ip addr add 10.0.0.2/32 dev dummy0');
    await sh(pc, 'sudo ip link set dummy0 up');
    expect(await sh(pc, 'ping -c 1 10.0.0.2')).toContain('1 received');

    await sh(pc, 'sudo ip link del dummy0');
    expect(await sh(pc, 'ip link show')).not.toContain('dummy0');
  });
});

describe('Linux : le module dummy', () => {
  it('`modprobe dummy` le charge, et `lsmod` le voit', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    expect(await sh(pc, 'lsmod')).not.toMatch(/^dummy\s/m);

    expect(await sh(pc, 'sudo modprobe dummy')).toBe('');
    expect(await sh(pc, 'lsmod')).toMatch(/^dummy\s/m);
    // `lsmod` n'est qu'une mise en forme de `/proc/modules` : les deux
    // ne peuvent pas diverger.
    expect(await sh(pc, 'cat /proc/modules')).toMatch(/^dummy /m);
  });

  it('`modinfo dummy` décrit le module chargé', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    await sh(pc, 'sudo modprobe dummy');
    const out = await sh(pc, 'modinfo dummy');
    expect(out).toContain('description:    Dummy network driver');
    expect(out).toMatch(/filename:.*dummy\.ko/);
  });

  it('`modprobe -r` le décharge', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    await sh(pc, 'sudo modprobe dummy');
    expect(await sh(pc, 'sudo modprobe -r dummy')).toBe('');
    expect(await sh(pc, 'lsmod')).not.toMatch(/^dummy\s/m);
  });

  /**
   * Le noyau charge le module à la demande : la table dit ce que la
   * machine sait faire, et les deux vues doivent s'accorder.
   */
  it('`ip link add … type dummy` charge le module tout seul', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    expect(await sh(pc, 'lsmod')).not.toMatch(/^dummy\s/m);
    await sh(pc, 'sudo ip link add lo1 type dummy');
    expect(await sh(pc, 'lsmod')).toMatch(/^dummy\s/m);
  });

  /**
   * La table décrit ce que cette image porte VRAIMENT : un module dont
   * aucun comportement n'existe ici ne se charge pas, exactement comme
   * sur une machine dont `/lib/modules` ne contient pas le fichier.
   */
  it('un module que cette image ne porte pas est refusé, en nommant le répertoire', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    const out = await sh(pc, 'sudo modprobe module_inexistant');
    expect(out).toContain('modprobe: FATAL: Module module_inexistant not found in directory /lib/modules/');
  });

  it('`which modprobe` le trouve dans sbin', async () => {
    const pc = new LinuxPC('linux-pc', 'srv1');
    expect(await sh(pc, 'which modprobe')).toBe('/usr/sbin/modprobe');
  });
});

// ── Windows, partie 6 du tutoriel ────────────────────────────────────

describe('Windows : la boucle et ses routes', () => {
  it('`ping 127.0.0.1` répond', async () => {
    const pc = new WindowsPC('windows-pc', 'WS1');
    const out = String(await pingOnSimulatedClock(pc, 'ping 127.0.0.1'));
    expect(out).toContain('Reply from 127.0.0.1');
    expect(out).toContain('Lost = 0 (0% loss)');
  });

  /**
   * Le tutoriel montre exactement ces trois lignes. La table
   * `Active Routes:` sortait VIDE sur un poste fraîchement démarré.
   */
  it('`route print` montre les trois routes de bouclage', async () => {
    const pc = new WindowsPC('windows-pc', 'WS1');
    const out = String(await pc.executeCommand('route print'));
    expect(out).toContain('Software Loopback Interface 1');
    expect(out).toMatch(/127\.0\.0\.0\s+255\.0\.0\.0\s+On-link\s+127\.0\.0\.1/);
    expect(out).toMatch(/127\.0\.0\.1\s+255\.255\.255\.255\s+On-link\s+127\.0\.0\.1/);
    expect(out).toMatch(/127\.255\.255\.255\s+255\.255\.255\.255\s+On-link\s+127\.0\.0\.1/);
  });

  /**
   * `route print`, `Get-NetRoute` et le fournisseur PowerShell
   * décrivaient chacun leurs routes de bouclage, avec des métriques
   * différentes. Le défaut n'était pas une ligne manquante mais trois
   * réponses à une question.
   */
  it('`Get-NetRoute` et `route print` s\'accordent sur la même table', async () => {
    const pc = new WindowsPC('windows-pc', 'WS1');
    const ps = String(await pc.executeCommand('powershell Get-NetRoute'));
    for (const prefix of ['127.0.0.0/8', '127.0.0.1/32', '127.255.255.255/32']) {
      expect(ps, prefix).toContain(prefix);
    }
    expect(ps).toContain('Loopback Pseudo-Interface 1');
    // La métrique est celle de `route print`, une seule fois déclarée.
    const routePrint = String(await pc.executeCommand('route print'));
    const metrique = routePrint.match(/127\.0\.0\.0\s+255\.0\.0\.0\s+On-link\s+\S+\s+(\d+)/);
    expect(metrique).not.toBeNull();
    expect(ps).toContain(metrique![1]);
  });

  it('`Get-NetIPAddress` connaît 127.0.0.1 et ::1', async () => {
    const pc = new WindowsPC('windows-pc', 'WS1');
    const out = String(await pc.executeCommand('powershell Get-NetIPAddress'));
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('::1');
    expect(out).toContain('Loopback Pseudo-Interface 1');
  });

  /**
   * `Get-NetAdapter` ne montre PAS la pseudo-interface : c'est le
   * comportement d'un vrai Windows, où elle est masquée. Fixé ici pour
   * que le jour où on la rendra adressable, elle n'apparaisse pas par
   * accident dans la liste ordinaire.
   *
   * Limite ASSUMÉE et mesurée : `-IncludeHidden` devrait la faire
   * apparaître et ne le fait pas. Le cmdlet moderne lit
   * `INetworkProvider.getAdapters()`, qui ne connaît que les cartes
   * réelles ; la branche `-IncludeHidden` existe dans l'ancien
   * formateur et n'est plus atteinte. La combler proprement demande que
   * la pseudo-interface devienne un vrai port de `WindowsPC` — comme
   * `lo` vient de le devenir sous Linux — et non une quatrième copie
   * écrite en dur, qui est exactement le défaut que ce fichier vient de
   * refermer pour les routes.
   */
  it('`Get-NetAdapter` masque la pseudo-interface', async () => {
    const pc = new WindowsPC('windows-pc', 'WS1');
    expect(String(await pc.executeCommand('powershell Get-NetAdapter')))
      .not.toContain('Loopback Pseudo-Interface 1');
  });
});
