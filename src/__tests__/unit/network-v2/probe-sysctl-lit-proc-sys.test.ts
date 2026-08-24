/**
 * `/proc/sys` est le magasin, `sysctl` en est le lecteur.
 *
 * Mesure de depart, sur une seule machine au meme instant :
 *
 *   sysctl net.ipv4.conf.all.arp_ignore        -> ""
 *   cat /proc/sys/net/ipv4/conf/all/arp_ignore -> "0"
 *   sysctl kernel.osrelease                    -> ""
 *   cat /proc/sys/kernel/osrelease             -> "5.15.0-130-generic"
 *   sysctl net.ipv4.ip_forward                 -> "net.ipv4.ip_forward = 0"
 *   cat /proc/sys/net/ipv4/ip_forward          -> No such file or directory
 *
 * Les deux vues n'etaient pas seulement en desaccord : elles etaient
 * DISJOINTES. `/proc/sys` portait un arbre entier de pseudo-fichiers
 * generes (ARP, voisinage, noyau, plage de ports ephemeres) que la
 * commande dont c'est le seul travail ne lisait pas, et la seule cle
 * qu'elle connaissait etait justement absente de l'arbre. `sysctl -a`
 * rendait zero ligne, et `sysctl -w zorglub.inexistant=1` etait accepte
 * en silence avec le code de retour 0.
 *
 * `sysctl` lit desormais `/proc/sys`, comme `lsmod` lit `/proc/modules`.
 * Les messages et les codes de retour sont ceux de procps-ng
 * (`src/sysctl.c`) : `cannot stat <chemin>` dans les DEUX sens pour une
 * cle absente, la branche EPERM pour une projection en lecture seule
 * — refuser vaut mieux qu'accepter sans effet —, `cannot open "<f>"`
 * pour un fichier de prechargement manquant, et
 * `<f>(<n>): invalid syntax, continuing...` pour une ligne malformee.
 *
 * Les trois cas qui passent des deux cotes sont nommes : « TEMOIN,
 * net.ipv4.ip_forward » (la seule cle que l'ancienne commande servait,
 * c'est son objet de passer des deux cotes) ; « TEMOIN, /proc/sys
 * repond » (il montre que l'arbre existait deja, ce qui est tout le
 * propos : rien n'a ete invente, seulement branche) ; et « `-e` tait
 * l'erreur », qui passait avant pour une raison qui ne prouve rien —
 * l'ancienne commande rendait la chaine vide et le code 0 pour TOUTE
 * cle, avec `-e` comme sans.
 */

import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('sysctl lit /proc/sys', () => {
  it('TEMOIN, net.ipv4.ip_forward : la cle deja servie repond toujours', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('sysctl net.ipv4.ip_forward'))
      .toBe('net.ipv4.ip_forward = 0');
  });

  it('TEMOIN, /proc/sys repond deja de lui-meme', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_ignore')).toBe('0');
    expect(await pc.executeCommand('cat /proc/sys/kernel/osrelease')).not.toBe('');
  });

  it('les deux vues rendent la meme valeur pour la meme cle', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    for (const [cle, chemin] of [
      ['net.ipv4.conf.all.arp_ignore', '/proc/sys/net/ipv4/conf/all/arp_ignore'],
      ['kernel.osrelease', '/proc/sys/kernel/osrelease'],
      ['net.ipv4.neigh.default.gc_stale_time', '/proc/sys/net/ipv4/neigh/default/gc_stale_time'],
    ]) {
      const fichier = await pc.executeCommand(`cat ${chemin}`);
      expect(await pc.executeCommand(`sysctl -n ${cle}`), cle).toBe(fichier);
    }
  });

  it('la cle que sysctl servait seule existe maintenant dans l arbre', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/ip_forward')).toBe('0');
    await pc.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/ip_forward')).toBe('1');
  });

  it('`sysctl -a` liste tout l arbre', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('sysctl -a');
    const lignes = out.split('\n').filter(Boolean);
    expect(lignes.length).toBeGreaterThan(20);
    expect(out).toContain('kernel.osrelease = ');
    expect(out).toContain('net.ipv4.ip_forward = 0');
    expect(out).toContain('net.ipv4.conf.all.arp_ignore = 0');
    for (const l of lignes) expect(l, l).toMatch(/^[a-z0-9._-]+ = /);
  });

  it('une cle inconnue est refusee dans les deux sens, avec les mots de procps', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const attendu = 'sysctl: cannot stat /proc/sys/zorglub/inexistant: No such file or directory';
    expect(await pc.executeCommand('sysctl -w zorglub.inexistant=1')).toBe(attendu);
    expect(await pc.executeCommand('sysctl zorglub.inexistant')).toBe(attendu);
    expect(await pc.executeCommand('sysctl -w zorglub.inexistant=1; echo $?')).toContain('1');
  });

  it('`-e` tait l erreur et rend le succes, comme procps', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('sysctl -e -w zorglub.inexistant=1')).toBe('');
    expect(await pc.executeCommand('sysctl -e -w zorglub.inexistant=1; echo $?')).toContain('0');
  });

  it('une projection en lecture seule refuse au lieu d accepter sans effet', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('sudo sysctl -w net.ipv4.conf.all.arp_ignore=1'))
      .toBe('sysctl: setting key "net.ipv4.conf.all.arp_ignore": Operation not permitted');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_ignore')).toBe('0');
  });

  it('une cle qui nomme un repertoire liste ce qu il contient', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('sysctl net.ipv4.neigh.default');
    expect(out).toContain('net.ipv4.neigh.default.gc_thresh1 = 128');
    expect(out).not.toContain('kernel.');
  });

  it('`-n`, `-N`, `-q` et `-r` decident de ce qui est rendu', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('sysctl -n net.ipv4.ip_forward')).toBe('0');
    expect(await pc.executeCommand('sysctl -N net.ipv4.ip_forward')).toBe('net.ipv4.ip_forward');
    expect(await pc.executeCommand('sudo sysctl -q -w net.ipv4.ip_forward=1')).toBe('');
    expect(await pc.executeCommand('sysctl -a -r ip_forward')).toBe('net.ipv4.ip_forward = 1');
  });

  it('`sysctl -p` applique le fichier, et le rapporte comme procps', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(
      "sudo sh -c 'printf \"# un commentaire\\nnet.ipv4.ip_forward = 1\\nzorglub.rien = 2\\n\" > /etc/sysctl.conf'");

    const out = await pc.executeCommand('sudo sysctl -p');
    expect(out).toContain('net.ipv4.ip_forward = 1');
    expect(out).toContain('sysctl: cannot stat /proc/sys/zorglub/rien: No such file or directory');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/ip_forward')).toBe('1');
  });

  it('`sysctl -p` sur un fichier absent le dit avec les mots de procps', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('sysctl -p /nexiste.pas'))
      .toBe('sysctl: cannot open "/nexiste.pas": No such file or directory');
  });

  it('une ligne malformee est signalee et la suivante est appliquee quand meme', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(
      "sudo sh -c 'printf \"cassee\\nnet.ipv4.ip_forward = 1\\n\" > /etc/sysctl.conf'");

    const out = await pc.executeCommand('sudo sysctl -p');
    expect(out).toContain('sysctl: /etc/sysctl.conf(1): invalid syntax, continuing...');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/ip_forward')).toBe('1');
  });

  it('`--system` annonce chaque fichier applique', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("sudo sh -c 'printf \"net.ipv4.ip_forward = 1\\n\" > /etc/sysctl.conf'");

    const out = await pc.executeCommand('sudo sysctl --system');
    expect(out).toContain('* Applying /etc/sysctl.conf ...');
    expect(out).toContain('net.ipv4.ip_forward = 1');
  });
});
