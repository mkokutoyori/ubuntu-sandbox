/**
 * Scénario 8 — Heredoc Linux pour lire et modifier des fichiers de
 * configuration système avec ! et #.
 *
 * Dans un heredoc, # n'est JAMAIS un commentaire bash ; << 'EOF' préserve
 * #, ! et $ sans aucune interprétation ; sudo tee est la méthode
 * correcte pour écrire un fichier protégé via heredoc ; les fichiers
 * générés sont identiques octet par octet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scénario 8 — Heredoc Linux pour fichiers de configuration système', () => {
  describe('problème 1 — # dans un heredoc n\'est PAS un commentaire bash', () => {
    it('les lignes # sont affichées telles quelles', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`cat << 'EOF'
# Ceci est affiché tel quel (PAS un commentaire bash)
# nameserver 192.168.10.1
nameserver 192.168.10.1
EOF`);
      expect(out).toBe([
        '# Ceci est affiché tel quel (PAS un commentaire bash)',
        '# nameserver 192.168.10.1',
        'nameserver 192.168.10.1',
      ].join('\n'));
    });
  });

  describe('problème 2 — génération de /etc/resolv.conf', () => {
    it('méthode 1 : heredoc quoté → fichier littéral avec # commentaires du fichier', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      // /etc/resolv.conf appartient à root : l'écriture passe par sudo tee
      // (la redirection simple est refusée, voir problème 4).
      await pc.executeCommand(`cat << 'EOF' | sudo tee /etc/resolv.conf > /dev/null
# Généré automatiquement par mandeng-network-config.sh
# NE PAS MODIFIER MANUELLEMENT
domain mandeng.lan
search mandeng.lan
nameserver 192.168.10.1
nameserver 192.168.10.2
options ndots:5 timeout:2 attempts:3 rotate
EOF`);
      const content = await pc.executeCommand('cat /etc/resolv.conf');
      expect(content).toBe([
        '# Généré automatiquement par mandeng-network-config.sh',
        '# NE PAS MODIFIER MANUELLEMENT',
        'domain mandeng.lan',
        'search mandeng.lan',
        'nameserver 192.168.10.1',
        'nameserver 192.168.10.2',
        'options ndots:5 timeout:2 attempts:3 rotate',
      ].join('\n'));
    });

    it('méthode 2 : heredoc non quoté → $(date) et variables DNS expandés, # préservés', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      await pc.executeCommand(`DNS_PRIMARY="192.168.10.1"
DNS_SECONDARY="192.168.10.2"
DOMAIN="mandeng.lan"
cat << EOF | sudo tee /etc/resolv.conf > /dev/null
# Généré le $(date '+%Y-%m-%d %H:%M:%S')
# Domaine: $DOMAIN
domain $DOMAIN
search $DOMAIN
nameserver $DNS_PRIMARY
nameserver $DNS_SECONDARY
options ndots:5 timeout:2 attempts:3
EOF`);
      const content = await pc.executeCommand('cat /etc/resolv.conf');
      expect(content).toMatch(/^# Généré le \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
      expect(content).toContain('# Domaine: mandeng.lan');
      expect(content).toContain('domain mandeng.lan');
      expect(content).toContain('nameserver 192.168.10.1');
      expect(content).toContain('nameserver 192.168.10.2');
      expect(content).toContain('options ndots:5 timeout:2 attempts:3');
    });
  });

  describe('problème 3 — ! dans les fichiers de configuration Linux', () => {
    it('shadow simulé : ! (compte verrouillé) et !! préservés sans expansion d\'historique', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      await pc.executeCommand(`cat << 'EOF' > /tmp/shadow-test.txt
root:$6$salt$hashedpassword:19000:0:99999:7:::
daemon:*:18000:0:99999:7:::
user-locked:!$6$salt$hash:19000:0:99999:7:::
user-disabled:!!:18000:0:99999:7:::
EOF`);
      const content = await pc.executeCommand('cat /tmp/shadow-test.txt');
      expect(content).toBe([
        'root:$6$salt$hashedpassword:19000:0:99999:7:::',
        'daemon:*:18000:0:99999:7:::',
        'user-locked:!$6$salt$hash:19000:0:99999:7:::',
        'user-disabled:!!:18000:0:99999:7:::',
      ].join('\n'));
    });

    it('sudoers avec négation ! : ADMINS ALL=(ALL) ALL, !DANGEROUS écrit tel quel', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      await pc.executeCommand(`cat << 'SUDOERS' > /tmp/sudoers-test.txt
# Fichier sudoers généré automatiquement
# /etc/sudoers.d/mandeng-policy
User_Alias ADMINS = user-admin, user-reseau
Cmnd_Alias DANGEROUS = /bin/su, /bin/bash, /usr/bin/vim /etc/sudoers
ADMINS ALL=(ALL) ALL, !DANGEROUS
SUDOERS`);
      const content = await pc.executeCommand('cat /tmp/sudoers-test.txt');
      expect(content).toBe([
        '# Fichier sudoers généré automatiquement',
        '# /etc/sudoers.d/mandeng-policy',
        'User_Alias ADMINS = user-admin, user-reseau',
        'Cmnd_Alias DANGEROUS = /bin/su, /bin/bash, /usr/bin/vim /etc/sudoers',
        'ADMINS ALL=(ALL) ALL, !DANGEROUS',
      ].join('\n'));
    });
  });

  describe('problème 4 — heredoc avec sudo tee pour écriture protégée', () => {
    it("méthode incorrecte : la redirection > s'exécute avec les droits de l'utilisateur courant → Permission denied", async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`sudo cat << 'EOF' > /etc/resolv.conf
# Ne fonctionne pas : la redirection > est faite par bash, pas par sudo
EOF`);
      expect(out).toContain('Permission denied');
    });

    it('cat << EOF | sudo tee /etc/resolv.conf > /dev/null : variables expandées, sortie console supprimée', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`DNS_PRIMARY="192.168.10.1"
cat << EOF | sudo tee /etc/resolv.conf > /dev/null
# Généré le $(date '+%Y-%m-%d %H:%M:%S')
nameserver $DNS_PRIMARY
options ndots:5
EOF`);
      // > /dev/null : tee n'affiche rien sur la console.
      expect(out).toBe('');

      const content = await pc.executeCommand('cat /etc/resolv.conf');
      expect(content).toMatch(/^# Généré le \d{4}-\d{2}-\d{2}/m);
      expect(content).toContain('nameserver 192.168.10.1');
      expect(content).toContain('options ndots:5');
    });

    it('sans > /dev/null, tee répète le contenu écrit sur la console', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(`cat << 'EOF' | sudo tee /tmp/tee-echo.txt
nameserver 192.168.10.9
EOF`);
      expect(out).toContain('nameserver 192.168.10.9');
      expect(await pc.executeCommand('cat /tmp/tee-echo.txt')).toBe('nameserver 192.168.10.9');
    });
  });

  describe('heredoc et crontab avec ! et #', () => {
    it('crontab - lit le heredoc : commentaires #, ! dans les commandes et || préservés', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      await pc.executeCommand(`crontab - << 'CRON'
# Surveillance réseau - généré automatiquement
# MIN HEURE JOUR MOIS JOURSEM COMMANDE
*/5 * * * * /usr/local/bin/process-monitor.sh >> /var/log/monitor.log 2>&1
0 2 * * * /usr/local/bin/backup.sh || echo "Backup failed!" | mail admin
# Fin du crontab
CRON`);
      const listed = await pc.executeCommand('crontab -l');
      expect(listed).toContain('# Surveillance réseau - généré automatiquement');
      expect(listed).toContain('# MIN HEURE JOUR MOIS JOURSEM COMMANDE');
      expect(listed).toContain('*/5 * * * * /usr/local/bin/process-monitor.sh >> /var/log/monitor.log 2>&1');
      expect(listed).toContain('0 2 * * * /usr/local/bin/backup.sh || echo "Backup failed!" | mail admin');
      expect(listed).toContain('# Fin du crontab');
    });
  });

  describe('critère de réussite', () => {
    it("<< 'EOF' préserve #, !, $ ; fichiers identiques octet par octet à la référence", async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const reference = [
        '# resolv de référence !important',
        'nameserver 192.168.10.1',
        'options timeout:2 # inline',
        'motif: $HOME et !! et \\backslash',
      ].join('\n');

      await pc.executeCommand(`cat << 'EOF' > /tmp/a.txt
# resolv de référence !important
nameserver 192.168.10.1
options timeout:2 # inline
motif: $HOME et !! et \\backslash
EOF`);
      expect(await pc.executeCommand('cat /tmp/a.txt')).toBe(reference);

      // Écriture par une autre voie (printf) → mêmes octets → même md5.
      await pc.executeCommand(
        "printf '%s\\n' '# resolv de référence !important' 'nameserver 192.168.10.1' 'options timeout:2 # inline' 'motif: $HOME et !! et \\backslash' > /tmp/b.txt",
      );
      const sums = await pc.executeCommand('md5sum /tmp/a.txt /tmp/b.txt');
      const [sumA, sumB] = sums.trim().split('\n').map((l) => l.split(/\s+/)[0]);
      expect(sumA).toBe(sumB);
    });
  });
});
