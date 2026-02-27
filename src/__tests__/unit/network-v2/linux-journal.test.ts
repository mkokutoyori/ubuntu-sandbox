/**
 * TDD Tests for Linux Logging System (DET-L4-002)
 * 
 * Group 1: Systemd Journal (journalctl)
 * Group 2: Syslog & Rsyslog Configuration
 * Group 3: Log Files Management & Rotation
 * Group 4: Log Monitoring & Analysis
 * Group 5: Audit System & Security Logging
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Systemd Journal (journalctl)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Systemd Journal (journalctl)', () => {

  describe('L-UBU-01: Basic journalctl operations', () => {
    it('should display system logs with journalctl', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Afficher tous les logs
      const allLogs = await server.executeCommand('journalctl');
      expect(allLogs).toContain('Logs begin');
      expect(allLogs).toContain('systemd');
      
      // Afficher les logs en temps réel
      await server.executeCommand('journalctl -f &');
      await server.executeCommand('sleep 0.1');
      await server.executeCommand('echo "Test log entry" | systemd-cat');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Afficher les logs depuis le démarrage
      const bootLogs = await server.executeCommand('journalctl -b');
      expect(bootLogs).toContain('kernel');
      
      // Afficher les logs inversés (les plus récents en premier)
      const reverseLogs = await server.executeCommand('journalctl -r');
      
      // Afficher un nombre spécifique de lignes
      const lines = await server.executeCommand('journalctl -n 20');
      const lineCount = lines.trim().split('\n').length;
      expect(lineCount).toBeGreaterThan(0);
      
      // Afficher depuis une heure spécifique
      const sinceLogs = await server.executeCommand('journalctl --since "1 hour ago"');
      
      // Afficher entre deux dates
      const rangeLogs = await server.executeCommand('journalctl --since "today 00:00" --until "today 23:59"');
    });

    it('should filter logs by unit and priority', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Filtrer par unité système
      const sshLogs = await server.executeCommand('journalctl -u ssh');
      expect(sshLogs).toContain('sshd');
      
      const systemdLogs = await server.executeCommand('journalctl -u systemd');
      expect(systemdLogs).toContain('systemd');
      
      // Filtrer par priorité
      const errorLogs = await server.executeCommand('journalctl -p err');
      const warningLogs = await server.executeCommand('journalctl -p warning');
      const infoLogs = await server.executeCommand('journalctl -p info');
      
      // Filtrer par PID
      const systemdPid = await server.executeCommand('systemctl show --property=MainPID --value systemd');
      if (systemdPid && systemdPid.trim() !== '0') {
        const pidLogs = await server.executeCommand(`journalctl _PID=${systemdPid.trim()}`);
      }
      
      // Filtrer par exécutable
      const executableLogs = await server.executeCommand('journalctl /usr/bin/bash');
      
      // Combiner plusieurs filtres
      const combined = await server.executeCommand('journalctl -u ssh -p err --since "today"');
    });

    it('should manage journal size and storage', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Vérifier l'utilisation du disque
      const diskUsage = await server.executeCommand('journalctl --disk-usage');
      expect(diskUsage).toContain('M');
      
      // Vider les logs (ne garder que les 2 derniers jours)
      await server.executeCommand('sudo journalctl --vacuum-time=2d');
      
      // Limiter la taille du journal
      await server.executeCommand('sudo journalctl --vacuum-size=100M');
      
      // Afficher les fichiers du journal
      const journalFiles = await server.executeCommand('sudo ls -la /var/log/journal/');
      
      // Forcer la rotation du journal
      await server.executeCommand('sudo journalctl --rotate');
      
      // Synchroniser les logs sur le disque
      await server.executeCommand('sudo journalctl --flush');
      
      // Vérifier la configuration du journal
      const config = await server.executeCommand('cat /etc/systemd/journald.conf');
      expect(config).toContain('[Journal]');
    });

    it('should export and import journal logs', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Exporter les logs en JSON
      const jsonExport = await server.executeCommand('journalctl --output=json');
      expect(jsonExport).toContain('{');
      
      // Exporter en JSON avec détails
      const jsonPretty = await server.executeCommand('journalctl --output=json-pretty');
      expect(jsonPretty).toContain('"MESSAGE"');
      
      // Exporter en format export (binaire)
      await server.executeCommand('journalctl --output=export > /tmp/journal.export');
      
      // Exporter en format court
      const short = await server.executeCommand('journalctl --output=short');
      
      // Exporter en format cat
      const catFormat = await server.executeCommand('journalctl --output=cat');
      
      // Exporter avec des champs spécifiques
      const fields = await server.executeCommand('journalctl --output=json --fields=MESSAGE,PRIORITY,_PID');
      
      // Restaurer depuis un export
      await server.executeCommand('sudo journalctl --file=/tmp/journal.export');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/journal.export');
    });
  });

  describe('L-UBU-02: Advanced journalctl features', () => {
    it('should use journalctl with custom output formats', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Format verbose
      const verbose = await server.executeCommand('journalctl -o verbose');
      expect(verbose).toContain('MESSAGE=');
      expect(verbose).toContain('PRIORITY=');
      
      // Format avec timestamp en UNIX
      const unixTime = await server.executeCommand('journalctl -o short-unix');
      
      // Format avec précision microsecondes
      const precise = await server.executeCommand('journalctl -o short-precise');
      expect(precise).toMatch(/\d{2}:\d{2}:\d{2}\.\d{6}/);
      
      // Format monochrome (sans couleur)
      const mono = await server.executeCommand('journalctl -o monochrome');
      
      // Afficher les champs disponibles
      const availableFields = await server.executeCommand('journalctl --fields');
      expect(availableFields).toContain('MESSAGE');
      expect(availableFields).toContain('PRIORITY');
      
      // Utiliser un format personnalisé
      const custom = await server.executeCommand('journalctl -o json --output-fields=MESSAGE,_PID,PRIORITY');
    });

    it('should follow logs in real-time with filtering', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Suivre les logs SSH en temps réel (démarré en arrière-plan)
      await server.executeCommand('journalctl -fu ssh --lines=0 &');
      
      // Générer un log de test
      await server.executeCommand('logger "Test SSH log entry"');
      await server.executeCommand('sleep 0.5');
      
      // Arrêter le suivi
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Suivre les logs système
      await server.executeCommand('journalctl -f -k &'); // -k pour les logs du kernel
      await server.executeCommand('sleep 0.5');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Suivre avec filtre de priorité
      await server.executeCommand('journalctl -f -p err &');
      await server.executeCommand('sleep 0.5');
      await server.executeCommand('kill %1 2>/dev/null');
    });

    it('should correlate logs using journalctl', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Afficher les logs avec l'ID de démarrage
      const bootId = await server.executeCommand('journalctl --list-boots');
      if (bootId.trim()) {
        const currentBoot = await server.executeCommand('journalctl -b');
      }
      
      // Afficher les logs du démarrage précédent
      const previousBoot = await server.executeCommand('journalctl -b -1');
      
      // Afficher l'ID de démarrage courant
      const currentBootId = await server.executeCommand('cat /proc/sys/kernel/random/boot_id');
      
      // Suivre les logs d'un utilisateur spécifique
      const userLogs = await server.executeCommand('journalctl _UID=1000');
      
      // Afficher les logs par code de sortie
      const exitCodeLogs = await server.executeCommand('journalctl _EXIT_STATUS=1');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Syslog & Rsyslog Configuration
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Syslog & Rsyslog Configuration', () => {

  describe('L-UBU-03: Traditional syslog management', () => {
    it('should view traditional log files', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Vérifier les fichiers de log principaux
      const syslog = await server.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('kernel');
      
      const authLog = await server.executeCommand('cat /var/log/auth.log');
      expect(authLog).toContain('authentication');
      
      const kernLog = await server.executeCommand('cat /var/log/kern.log');
      
      const messages = await server.executeCommand('cat /var/log/messages');
      
      // Vérifier les logs d'authentification
      const secure = await server.executeCommand('cat /var/log/secure');
      
      // Vérifier les logs de démarrage
      const bootLog = await server.executeCommand('cat /var/log/boot.log');
      
      // Vérifier les logs dpkg
      const dpkgLog = await server.executeCommand('cat /var/log/dpkg.log');
      
      // Vérifier les logs apt
      const aptHistory = await server.executeCommand('cat /var/log/apt/history.log');
      const aptTerm = await server.executeCommand('cat /var/log/apt/term.log');
    });

    it('should configure rsyslog basic rules', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Sauvegarder la configuration existante
      await server.executeCommand('sudo cp /etc/rsyslog.conf /etc/rsyslog.conf.backup');
      
      // Vérifier la configuration rsyslog
      const rsyslogConf = await server.executeCommand('cat /etc/rsyslog.conf');
      expect(rsyslogConf).toContain('*.info');
      
      // Ajouter une règle personnalisée
      const customRule = `
# Log all kernel messages to separate file
kern.*     /var/log/kernel.log

# Log authentication messages
auth,authpriv.*     /var/log/auth.log

# Log mail messages
mail.*     /var/log/mail.log

# Log cron jobs
cron.*     /var/log/cron.log

# Emergency messages to all users
*.emerg     :omusrmsg:*

# Log everything except mail and authpriv
*.*;auth,authpriv.none     -/var/log/syslog
      `;
      
      await server.executeCommand(`echo '${customRule}' | sudo tee /etc/rsyslog.d/50-custom.conf`);
      
      // Recharger rsyslog
      await server.executeCommand('sudo systemctl restart rsyslog');
      
      // Vérifier le statut
      const status = await server.executeCommand('sudo systemctl status rsyslog');
      expect(status).toContain('active (running)');
      
      // Tester la journalisation
      await server.executeCommand('logger -p kern.warn "Test kernel warning"');
      await server.executeCommand('logger -p auth.info "Test auth info"');
      await server.executeCommand('logger -p mail.err "Test mail error"');
      await server.executeCommand('logger -p cron.debug "Test cron debug"');
      
      // Vérifier que les fichiers sont créés
      const kernelLog = await server.executeCommand('ls /var/log/kernel.log 2>/dev/null || echo "not found"');
      const authLog = await server.executeCommand('ls /var/log/auth.log 2>/dev/null || echo "not found"');
      
      // Restaurer la configuration
      await server.executeCommand('sudo cp /etc/rsyslog.conf.backup /etc/rsyslog.conf');
      await server.executeCommand('sudo rm -f /etc/rsyslog.d/50-custom.conf');
      await server.executeCommand('sudo systemctl restart rsyslog');
    });

    it('should configure remote logging with rsyslog', async () => {
      const server = new LinuxServer('linux-server', 'LOG-CLIENT');
      
      // Configurer l'envoi vers un serveur syslog distant
      const remoteConfig = `
# Send all logs to remote server
*.* @192.168.1.100:514

# Send only important logs to another server
*.emerg @192.168.1.101:514
*.alert @192.168.1.101:514
*.crit @192.168.1.101:514

# Send via TCP avec tag
*.* @@logs.example.com:6514;RSYSLOG_TraditionalForwardFormat

# Send with template
$template RemoteLogs,"/var/log/remote/%HOSTNAME%/%PROGRAMNAME%.log"
*.* ?RemoteLogs
      `;
      
      await server.executeCommand(`echo '${remoteConfig}' | sudo tee /etc/rsyslog.d/60-remote.conf`);
      
      // Configurer le serveur pour recevoir les logs
      const serverConfig = `
# Enable UDP reception
module(load="imudp")
input(type="imudp" port="514")

# Enable TCP reception
module(load="imtcp")
input(type="imtcp" port="514")

# Template for storing logs by host
$template TmplAuth,"/var/log/remote/%HOSTNAME%/%PROGRAMNAME%.log"
authpriv.* ?TmplAuth

$template TmplMsg,"/var/log/remote/%HOSTNAME%/messages.log"
*.* ?TmplMsg
      `;
      
      // Recharger rsyslog
      await server.executeCommand('sudo systemctl restart rsyslog');
      
      // Vérifier l'écoute sur les ports
      const netstat = await server.executeCommand('sudo netstat -tulpn | grep 514');
      
      // Tester l'envoi vers localhost
      await server.executeCommand('logger -n localhost -P 514 "Test remote log"');
      
      // Nettoyer
      await server.executeCommand('sudo rm -f /etc/rsyslog.d/60-remote.conf');
      await server.executeCommand('sudo systemctl restart rsyslog');
    });
  });

  describe('L-UBU-04: Advanced rsyslog configuration', () => {
    it('should use rsyslog templates and filters', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer un template personnalisé
      const templateConfig = `
# Template for custom format
$template MyTemplate,"%timegenerated% %HOSTNAME% %syslogtag%%msg%\n"

# Template with precise timestamp
$template PreciseFormat,"%$YEAR%-%$MONTH%-%$DAY% %timegenerated:12:23:date-rfc3339% %HOSTNAME% %syslogtag%%msg%\n"

# Template for JSON output
$template JsonTemplate,"{\"timestamp\":\"%timegenerated:::date-rfc3339%\",\"host\":\"%HOSTNAME%\",\"severity\":\"%syslogseverity-text%\",\"tag\":\"%syslogtag%\",\"message\":\"%msg%\"}\n"

# Apply template
*.* /var/log/all.log;MyTemplate
      `;
      
      await server.executeCommand(`echo '${templateConfig}' | sudo tee /etc/rsyslog.d/70-templates.conf`);
      
      // Configurer des filtres basés sur le contenu
      const filterConfig = `
# Filter messages containing "error"
:msg, contains, "error" /var/log/errors.log

# Filter messages from specific program
:programname, isequal, "sshd" /var/log/ssh.log

# Filter by facility and severity
auth.*;authpriv.* /var/log/auth.log
*.info;mail.none;authpriv.none;cron.none /var/log/messages

# Discard specific messages
:msg, contains, "debug" ~
:msg, contains, "test" stop
      `;
      
      await server.executeCommand(`echo '${filterConfig}' | sudo tee /etc/rsyslog.d/80-filters.conf`);
      
      // Recharger et tester
      await server.executeCommand('sudo systemctl restart rsyslog');
      await server.executeCommand('logger "This is an error message"');
      await server.executeCommand('logger "This is a test message"');
      await server.executeCommand('logger "SSH test"');
      
      // Nettoyer
      await server.executeCommand('sudo rm -f /etc/rsyslog.d/70-templates.conf /etc/rsyslog.d/80-filters.conf');
      await server.executeCommand('sudo systemctl restart rsyslog');
    });

    it('should configure log rotation in rsyslog', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Configurer la rotation dans rsyslog
      const rotationConfig = `
# Rotate log file when it reaches 100MB
$outchannel log_rotation,/var/log/myapp.log,104857600,/usr/local/bin/rotate.sh

# Apply the rotation
*.* :omfile:$log_rotation

# Rotation basée sur le temps
$template DailyLog,"/var/log/daily/%$YEAR%/%$MONTH%/%$DAY%.log"
*.* ?DailyLog

# Rotation combinée taille/temps
$template CustomLog,"/var/log/custom.log"
$FileCreateMode 0644
$FileOwner syslog
$FileGroup adm
$FileMaxSize 10M
$FileMaxWait 3600
*.* ?CustomLog
      `;
      
      // Créer le script de rotation
      const rotateScript = `#!/bin/bash
mv /var/log/myapp.log /var/log/myapp.log.1
gzip /var/log/myapp.log.1
find /var/log -name "myapp.log.*.gz" -mtime +30 -delete
      `;
      
      await server.executeCommand(`echo '${rotateScript}' | sudo tee /usr/local/bin/rotate.sh`);
      await server.executeCommand('sudo chmod +x /usr/local/bin/rotate.sh');
      
      // Appliquer configuration
      await server.executeCommand(`echo '${rotationConfig}' | sudo tee /etc/rsyslog.d/90-rotation.conf`);
      await server.executeCommand('sudo systemctl restart rsyslog');
      
      // Nettoyer
      await server.executeCommand('sudo rm -f /etc/rsyslog.d/90-rotation.conf /usr/local/bin/rotate.sh');
      await server.executeCommand('sudo systemctl restart rsyslog');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Log Files Management & Rotation
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Log Files Management & Rotation', () => {

  describe('L-UBU-05: Logrotate configuration', () => {
    it('should configure basic logrotate rules', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Vérifier la configuration logrotate globale
      const mainConfig = await server.executeCommand('cat /etc/logrotate.conf');
      expect(mainConfig).toContain('weekly');
      expect(mainConfig).toContain('rotate');
      
      // Créer une configuration pour une application
      const appConfig = `
/var/log/myapp/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 640 root adm
    sharedscripts
    postrotate
        /usr/bin/systemctl reload myapp > /dev/null 2>&1 || true
    endscript
}
      `;
      
      await server.executeCommand(`echo '${appConfig}' | sudo tee /etc/logrotate.d/myapp`);
      
      // Tester la configuration
      const testOutput = await server.executeCommand('sudo logrotate -d /etc/logrotate.d/myapp');
      expect(testOutput).toContain('rotating pattern');
      
      // Forcer la rotation
      await server.executeCommand('sudo logrotate -f /etc/logrotate.d/myapp');
      
      // Vérifier l'état de logrotate
      const status = await server.executeCommand('cat /var/lib/logrotate/status');
      
      // Nettoyer
      await server.executeCommand('sudo rm -f /etc/logrotate.d/myapp');
    });

    it('should configure complex logrotate scenarios', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Configuration complexe avec plusieurs options
      const complexConfig = `
# Application logs with size-based rotation
/var/log/nginx/*.log {
    size 100M
    hourly
    rotate 24
    compress
    dateext
    dateformat .%Y-%m-%d-%H
    missingok
    notifempty
    sharedscripts
    postrotate
        [ ! -f /var/run/nginx.pid ] || kill -USR1 \`cat /var/run/nginx.pid\`
    endscript
}

# Database logs with specific permissions
/var/log/postgresql/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    create 640 postgres adm
    su postgres postgres
    prerotate
        /usr/bin/pg_ctl -D /var/lib/postgresql/data logrotate
    endscript
}

# System logs with olddir
/var/log/syslog
/var/log/messages {
    weekly
    rotate 4
    compress
    delaycompress
    missingok
    olddir /var/log/archive
    create 640 root adm
}
      `;
      
      await server.executeCommand(`echo '${complexConfig}' | sudo tee /etc/logrotate.d/complex`);
      
      // Créer le répertoire d'archive
      await server.executeCommand('sudo mkdir -p /var/log/archive');
      
      // Tester avec le mode debug
      const debugOutput = await server.executeCommand('sudo logrotate -v /etc/logrotate.d/complex');
      expect(debugOutput).toContain('reading config file');
      
      // Vérifier la syntaxe
      const syntaxCheck = await server.executeCommand('sudo logrotate -d /etc/logrotate.conf');
      expect(syntaxCheck).not.toContain('error');
      
      // Nettoyer
      await server.executeCommand('sudo rm -f /etc/logrotate.d/complex');
      await server.executeCommand('sudo rm -rf /var/log/archive');
    });

    it('should handle logrotate errors and special cases', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer un fichier de log pour le test
      await server.executeCommand('sudo touch /var/log/testapp.log');
      await server.executeCommand('echo "Test log entry" | sudo tee -a /var/log/testapp.log');
      
      // Configuration avec erreur délibérée pour tester
      const errorConfig = `
/var/log/testapp.log {
    daily
    rotate 5
    compress
    missingok
    create
    # Missing permissions - should generate warning
}
      `;
      
      await server.executeCommand(`echo '${errorConfig}' | sudo tee /etc/logrotate.d/testapp`);
      
      // Tester avec sortie verbeuse
      const verboseOutput = await server.executeCommand('sudo logrotate -v /etc/logrotate.d/testapp 2>&1');
      
      // Forcer la rotation même avec des erreurs
      await server.executeCommand('sudo logrotate -f /etc/logrotate.d/testapp 2>&1 || true');
      
      // Vérifier les fichiers rotationnés
      const rotatedFiles = await server.executeCommand('ls -la /var/log/testapp.log* 2>/dev/null || echo "none"');
      
      // Nettoyer
      await server.executeCommand('sudo rm -f /etc/logrotate.d/testapp /var/log/testapp.log*');
    });
  });

  describe('L-UBU-06: Manual log management', () => {
    it('should manually rotate and compress logs', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer un fichier de log de test
      await server.executeCommand('echo "Line 1" > /tmp/mylog.log');
      for (let i = 2; i <= 100; i++) {
        await server.executeCommand(`echo "Line ${i}" >> /tmp/mylog.log`);
      }
      
      // Rotation manuelle
      await server.executeCommand('mv /tmp/mylog.log /tmp/mylog.log.1');
      
      // Créer un nouveau fichier vide
      await server.executeCommand('touch /tmp/mylog.log');
      
      // Compression des anciens logs
      await server.executeCommand('gzip /tmp/mylog.log.1');
      
      // Vérifier la compression
      const gzFile = await server.executeCommand('ls -lh /tmp/mylog.log.1.gz');
      expect(gzFile).toContain('.gz');
      
      // Décompresser pour vérification
      await server.executeCommand('gunzip -c /tmp/mylog.log.1.gz | head -5');
      
      // Rotation avec numérotation
      await server.executeCommand('cp /tmp/mylog.log.1.gz /tmp/mylog.log.2.gz');
      
      // Suppression des vieux logs
      await server.executeCommand('find /tmp -name "mylog.log.*.gz" -mtime +7 -delete');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/mylog.log*');
    });

    it('should clean up log files automatically', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer des fichiers de log de test de différentes tailles et âges
      const now = Date.now();
      for (let i = 1; i <= 5; i++) {
        await server.executeCommand(`echo "Old log file ${i}" > /tmp/logfile_${i}_days_old.log`);
        // Simuler des fichiers plus anciens en touchant avec une date passée
        const oldDate = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        await server.executeCommand(`touch -d "${oldDate}" /tmp/logfile_${i}_days_old.log`);
      }
      
      // Supprimer les logs de plus de 3 jours
      await server.executeCommand('find /tmp -name "*.log" -mtime +3 -delete');
      
      // Vérifier que seuls les fichiers récents restent
      const remaining = await server.executeCommand('ls /tmp/*.log 2>/dev/null | wc -l');
      
      // Nettoyer par taille
      await server.executeCommand('echo "Large content" > /tmp/large.log');
      for (let i = 0; i < 1000; i++) {
        await server.executeCommand('echo "Additional line to increase size" >> /tmp/large.log');
      }
      
      // Trouver les fichiers de plus de 1K
      const largeFiles = await server.executeCommand('find /tmp -name "*.log" -size +1k');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/*.log');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Log Monitoring & Analysis
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Log Monitoring & Analysis', () => {

  describe('L-UBU-07: Real-time log monitoring', () => {
    it('should monitor logs in real-time with tail', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Suivre un fichier en temps réel
      await server.executeCommand('tail -f /var/log/syslog &');
      
      // Générer des entrées de log
      await server.executeCommand('logger "Test message 1 for tail monitoring"');
      await server.executeCommand('sleep 0.5');
      await server.executeCommand('logger "Test message 2 for tail monitoring"');
      
      // Arrêter le suivi
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Suivre avec numérotation des lignes
      await server.executeCommand('tail -n 20 -f /var/log/auth.log &');
      await server.executeCommand('sleep 0.5');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Suivre plusieurs fichiers
      await server.executeCommand('tail -f /var/log/syslog /var/log/auth.log &');
      await server.executeCommand('sleep 0.5');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Suivre avec affichage en continu (pas seulement les nouvelles lignes)
      await server.executeCommand('tail -f -s 1 /var/log/syslog &'); // Mise à jour chaque seconde
      await server.executeCommand('sleep 2');
      await server.executeCommand('kill %1 2>/dev/null');
    });

    it('should use multitail for multiple log files', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Installer multitail (simulation)
      await server.executeCommand('which multitail || echo "multitail not installed"');
      
      // Commandes multitail typiques
      const multitailExamples = `
# Surveiller deux fichiers côte à côte
multitail /var/log/syslog /var/log/auth.log

# Surveiller avec couleurs par type
multitail -cS syslog /var/log/syslog -cS ssh /var/log/auth.log

# Surveiller avec des filtres
multitail -l "ssh" -l "tail -f /var/log/nginx/access.log"

# Surveiller avec fenêtres divisées
multitail -s 2 /var/log/syslog /var/log/auth.log /var/log/kern.log
      `;
      
      // En pratique, on pourrait tester si multitail est installé
      const multitailCheck = await server.executeCommand('which multitail');
      if (multitailCheck.trim()) {
        await server.executeCommand('multitail -V');
      }
    });

    it('should monitor logs with watch command', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Surveiller la taille d'un fichier de log
      await server.executeCommand('watch -n 2 "ls -lh /var/log/syslog" &');
      await server.executeCommand('sleep 5');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Surveiller les dernières lignes
      await server.executeCommand('watch -n 1 "tail -n 5 /var/log/syslog" &');
      await server.executeCommand('sleep 5');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Surveiller avec en-tête personnalisé
      await server.executeCommand('watch -n 2 -t "tail -n 3 /var/log/syslog | wc -l" &');
      await server.executeCommand('sleep 5');
      await server.executeCommand('kill %1 2>/dev/null');
      
      // Surveiller la croissance d'un fichier
      await server.executeCommand('watch -d -n 1 "tail -n 1 /var/log/syslog" &');
      await server.executeCommand('sleep 5');
      await server.executeCommand('kill %1 2>/dev/null');
    });
  });

  describe('L-UBU-08: Log analysis with command line tools', () => {
    it('should analyze logs with grep and regular expressions', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer des logs de test
      const testLogs = `
2024-01-15 10:30:45 ERROR Database connection failed
2024-01-15 10:31:22 WARNING High memory usage detected
2024-01-15 10:32:15 INFO User login successful
2024-01-15 10:33:00 ERROR File not found: /var/www/index.html
2024-01-15 10:34:12 INFO Backup completed successfully
2024-01-15 10:35:45 CRITICAL System overheating
2024-01-15 10:36:30 DEBUG Processing request ID 12345
      `;
      
      await server.executeCommand(`echo '${testLogs}' > /tmp/test_analysis.log`);
      
      // Rechercher les erreurs
      const errors = await server.executeCommand('grep -i error /tmp/test_analysis.log');
      expect(errors.split('\n').length).toBe(2);
      
      // Rechercher avec expression régulière
      const timePattern = await server.executeCommand('grep -E "^2024.*10:3[0-5]" /tmp/test_analysis.log');
      
      // Compter les occurrences
      const errorCount = await server.executeCommand('grep -c ERROR /tmp/test_analysis.log');
      expect(parseInt(errorCount)).toBe(2);
      
      const warningCount = await server.executeCommand('grep -c WARNING /tmp/test_analysis.log');
      expect(parseInt(warningCount)).toBe(1);
      
      // Rechercher plusieurs patterns
      const criticalErrors = await server.executeCommand('grep -e "ERROR" -e "CRITICAL" /tmp/test_analysis.log');
      
      // Inverser la recherche (lignes sans ERROR)
      const nonErrors = await server.executeCommand('grep -v ERROR /tmp/test_analysis.log');
      
      // Context before/after
      const context = await server.executeCommand('grep -B1 -A1 "WARNING" /tmp/test_analysis.log');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/test_analysis.log');
    });

    it('should use awk for log statistics and reporting', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer un fichier de log structuré
      const structuredLogs = `
timestamp=2024-01-15T10:30:45 level=ERROR message="Database connection failed" user=admin ip=192.168.1.100
timestamp=2024-01-15T10:31:22 level=WARNING message="High memory usage" memory=85%
timestamp=2024-01-15T10:32:15 level=INFO message="User login" user=jdoe ip=192.168.1.101
timestamp=2024-01-15T10:33:00 level=ERROR message="File not found" file="/var/www/index.html"
timestamp=2024-01-15T10:34:12 level=INFO message="Backup completed" size="1.2GB"
timestamp=2024-01-15T10:35:45 level=CRITICAL message="System overheating" temperature=95
timestamp=2024-01-15T10:36:30 level=DEBUG message="Processing request" request_id=12345
      `;
      
      await server.executeCommand(`echo '${structuredLogs}' > /tmp/structured.log`);
      
      // Extraire des champs spécifiques
      const timestamps = await server.executeCommand('awk -F"timestamp=" \'{split($2,a," "); print a[1]}\' /tmp/structured.log');
      
      // Compter par niveau
      const levelCounts = await server.executeCommand('awk -F"level=" \'{split($2,a," "); count[a[1]]++} END {for (l in count) print l ": " count[l]}\' /tmp/structured.log');
      expect(levelCounts).toContain('ERROR');
      
      // Filtrer et formater
      const errorReports = await server.executeCommand('awk -F"level=" \'/level=ERROR/ {split($2,a," "); print "ERROR detected: " a[1]}\' /tmp/structured.log');
      
      // Calculer des statistiques
      const stats = await server.executeCommand('awk \'BEGIN{errors=0; warnings=0; infos=0} /level=ERROR/{errors++} /level=WARNING/{warnings++} /level=INFO/{infos++} END{print "Errors:", errors, "Warnings:", warnings, "Infos:", infos}\' /tmp/structured.log');
      
      // Extraire les adresses IP
      const ips = await server.executeCommand('awk -F"ip=" \'/ip=/ {split($2,a," "); print a[1]}\' /tmp/structured.log | sort -u');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/structured.log');
    });

    it('should analyze logs with sed for transformation', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer un fichier de log simple
      const simpleLogs = `
ERROR: Database connection failed at 10:30
WARNING: Memory usage high at 10:31
INFO: User login at 10:32
ERROR: File not found at 10:33
INFO: Backup completed at 10:34
CRITICAL: System overheating at 10:35
      `;
      
      await server.executeCommand(`echo '${simpleLogs}' > /tmp/simple.log`);
      
      // Remplacer ERROR par ERREUR
      const frenchLogs = await server.executeCommand('sed "s/ERROR/ERREUR/g" /tmp/simple.log');
      expect(frenchLogs).toContain('ERREUR');
      
      // Supprimer les lignes INFO
      const noInfo = await server.executeCommand('sed "/INFO/d" /tmp/simple.log');
      expect(noInfo).not.toContain('INFO');
      
      // Extraire seulement les heures
      const hours = await server.executeCommand('sed -n "s/.*at \\([0-9:]\\+\\)$/\\1/p" /tmp/simple.log');
      
      // Ajouter un préfixe
      const prefixed = await server.executeCommand('sed "s/^/[LOG] /" /tmp/simple.log');
      expect(prefixed).toContain('[LOG]');
      
      // Traiter plusieurs transformations
      const processed = await server.executeCommand('sed -e "s/ERROR/ERREUR/" -e "s/WARNING/AVERTISSEMENT/" -e "s/INFO/INFORMATION/" /tmp/simple.log');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/simple.log');
    });
  });

  describe('L-UBU-09: Log aggregation and summary', () => {
    it('should aggregate logs with sort, uniq, and wc', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer des logs avec des doublons
      const duplicateLogs = `
user=jdoe action=login status=success
user=jsmith action=login status=success
user=jdoe action=login status=failed
user=jsmith action=logout status=success
user=jdoe action=login status=success
user=admin action=login status=success
user=jsmith action=login status=success
      `;
      
      await server.executeCommand(`echo '${duplicateLogs}' > /tmp/duplicate.log`);
      
      // Compter les lignes totales
      const totalLines = await server.executeCommand('wc -l /tmp/duplicate.log');
      expect(parseInt(totalLines)).toBe(7);
      
      // Compter les lignes uniques
      const uniqueLines = await server.executeCommand('sort /tmp/duplicate.log | uniq | wc -l');
      
      // Afficher les lignes uniques
      const unique = await server.executeCommand('sort /tmp/duplicate.log | uniq');
      
      // Compter les occurrences de chaque ligne
      const counts = await server.executeCommand('sort /tmp/duplicate.log | uniq -c');
      expect(counts).toContain('2'); // Au moins une ligne apparaît deux fois
      
      // Trier par nombre d'occurrences
      const sortedCounts = await server.executeCommand('sort /tmp/duplicate.log | uniq -c | sort -rn');
      
      // Extraire et compter les utilisateurs
      const users = await server.executeCommand('awk -F"=" \'{split($2,a," "); print a[1]}\' /tmp/duplicate.log | sort | uniq -c');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/duplicate.log');
    });

    it('should generate log summaries and reports', async () => {
      const server = new LinuxServer('linux-server', 'LOG-SRV');
      
      // Créer des logs d'application
      const appLogs = `
2024-01-15 10:30:45 [ERROR] [AppServer] Database connection failed
2024-01-15 10:31:22 [WARNING] [AppServer] High memory usage: 85%
2024-01-15 10:32:15 [INFO] [AuthService] User jdoe logged in
2024-01-15 10:33:00 [ERROR] [FileService] File not found: /var/www/index.html
2024-01-15 10:34:12 [INFO] [BackupService] Backup completed: 1.2GB
2024-01-15 10:35:45 [CRITICAL] [MonitorService] System overheating: 95°C
2024-01-15 10:36:30 [DEBUG] [AppServer] Processing request ID 12345
2024-01-15 10:37:15 [INFO] [AuthService] User jsmith logged out
      `;
      
      await server.executeCommand(`echo '${appLogs}' > /tmp/app.log`);
      
      // Générer un rapport d'erreurs
      const errorReport = await server.executeCommand('grep -c "\\[ERROR\\]" /tmp/app.log');
      const warningReport = await server.executeCommand('grep -c "\\[WARNING\\]" /tmp/app.log');
      const criticalReport = await server.executeCommand('grep -c "\\[CRITICAL\\]" /tmp/app.log');
      
      // Rapport par service
      const serviceReport = await server.executeCommand('grep -o "\\[.*Service\\]" /tmp/app.log | sort | uniq -c');
      
      // Rapport horaire
      const hourlyReport = await server.executeCommand('awk \'{print substr($2,1,2)}\' /tmp/app.log | sort | uniq -c');
      
      // Créer un rapport texte
      const summary = `
=== Log Analysis Report ===
Generated: $(date)
Total entries: $(wc -l < /tmp/app.log)
Errors: $(grep -c "\\[ERROR\\]" /tmp/app.log)
Warnings: $(grep -c "\\[WARNING\\]" /tmp/app.log)
Critical: $(grep -c "\\[CRITICAL\\]" /tmp/app.log)

Top services:
$(grep -o "\\[.*Service\\]" /tmp/app.log | sort | uniq -c | sort -rn)
      `;
      
      await server.executeCommand(`echo '${summary}' > /tmp/log_report.txt`);
      
      // Vérifier le rapport
      const report = await server.executeCommand('cat /tmp/log_report.txt');
      expect(report).toContain('Log Analysis Report');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/app.log /tmp/log_report.txt');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Audit System & Security Logging
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Audit System & Security Logging', () => {

  describe('L-UBU-10: Linux audit system (auditd)', () => {
    it('should configure and use auditd basic rules', async () => {
      const server = new LinuxServer('linux-server', 'AUDIT-SRV');
      
      // Vérifier si auditd est installé
      const auditdCheck = await server.executeCommand('which auditctl || echo "auditctl not found"');
      
      if (!auditdCheck.includes('not found')) {
        // Vérifier le statut
        const status = await server.executeCommand('sudo systemctl status auditd');
        expect(status).toContain('active');
        
        // Lister les règles actuelles
        const rules = await server.executeCommand('sudo auditctl -l');
        
        // Ajouter une règle pour surveiller un fichier
        await server.executeCommand('sudo auditctl -w /etc/passwd -p wa -k passwd_changes');
        
        // Ajouter une règle pour surveiller les connexions
        await server.executeCommand('sudo auditctl -a always,exit -F arch=b64 -S connect -F a2=1024 -k network_connections');
        
        // Vérifier les règles ajoutées
        const updatedRules = await server.executeCommand('sudo auditctl -l');
        expect(updatedRules).toContain('/etc/passwd');
        
        // Supprimer toutes les règles
        await server.executeCommand('sudo auditctl -D');
        
        // Vérifier que les règles sont supprimées
        const emptyRules = await server.executeCommand('sudo auditctl -l');
        expect(emptyRules.trim()).toBe('No rules');
      }
    });

    it('should search and analyze audit logs', async () => {
      const server = new LinuxServer('linux-server', 'AUDIT-SRV');
      
      const auditdCheck = await server.executeCommand('which ausearch || echo "ausearch not found"');
      
      if (!auditdCheck.includes('not found')) {
        // Rechercher des événements récents
        const recentEvents = await server.executeCommand('sudo ausearch --start today');
        
        // Rechercher par clé
        const keyEvents = await server.executeCommand('sudo ausearch -k passwd_changes');
        
        // Rechercher par type d'événement
        const loginEvents = await server.executeCommand('sudo ausearch -m USER_LOGIN');
        
        // Rechercher par UID
        const rootEvents = await server.executeCommand('sudo ausearch -ui 0');
        
        // Rechercher par exécutable
        const bashEvents = await server.executeCommand('sudo ausearch -x /bin/bash');
        
        // Rechercher avec format détaillé
        const detailed = await server.executeCommand('sudo ausearch --format raw');
        
        // Générer un rapport
        const report = await server.executeCommand('sudo aureport --summary');
        expect(report).toContain('Summary Report');
      }
    });

    it('should generate audit reports with aureport', async () => {
      const server = new LinuxServer('linux-server', 'AUDIT-SRV');
      
      const aureportCheck = await server.executeCommand('which aureport || echo "aureport not found"');
      
      if (!aureportCheck.includes('not found')) {
        // Rapport des événements
        const eventReport = await server.executeCommand('sudo aureport -e');
        
        // Rapport des fichiers surveillés
        const fileReport = await server.executeCommand('sudo aureport -f');
        
        // Rapport des connexions
        const loginReport = await server.executeCommand('sudo aureport -l');
        
        // Rapport des modifications de fichiers
        const modReport = await server.executeCommand('sudo aureport --file');
        
        // Rapport par utilisateur
        const userReport = await server.executeCommand('sudo aureport -u');
        
        // Rapport par exécutable
        const exeReport = await server.executeCommand('sudo aureport -x');
        
        // Rapport d'échecs
        const failedReport = await server.executeCommand('sudo aureport --failed');
        
        // Rapport global
        const summary = await server.executeCommand('sudo aureport --summary');
      }
    });
  });

  describe('L-UBU-11: Security logging and monitoring', () => {
    it('should monitor failed login attempts', async () => {
      const server = new LinuxServer('linux-server', 'SEC-SRV');
      
      // Surveiller les échecs d'authentification SSH
      const sshFailed = await server.executeCommand('grep "Failed password" /var/log/auth.log | tail -10');
      
      // Compter les échecs par IP
      const failedByIP = await server.executeCommand('grep "Failed password" /var/log/auth.log | awk \'{print $(NF-3)}\' | sort | uniq -c | sort -rn');
      
      // Surveiller les tentatives de connexion invalides
      const invalidUsers = await server.executeCommand('grep "Invalid user" /var/log/auth.log | awk \'{print $8}\' | sort | uniq -c | sort -rn');
      
      // Surveiller les connexions root
      const rootLogins = await server.executeCommand('grep "root" /var/log/auth.log | grep "session opened"');
      
      // Créer un script de surveillance
      const monitorScript = `#!/bin/bash
LOG_FILE="/var/log/auth.log"
ALERT_FILE="/tmp/failed_logins_alert.txt"
THRESHOLD=5

# Compter les échecs récents
FAILED_COUNT=$(grep "Failed password" "$LOG_FILE" | grep "$(date +'%b %d %H:')" | wc -l)

if [ "$FAILED_COUNT" -gt "$THRESHOLD" ]; then
    echo "[ALERT] $FAILED_COUNT failed login attempts detected at $(date)" > "$ALERT_FILE"
    # Envoyer une notification (simulée)
    echo "Notification sent: $FAILED_COUNT failed logins"
fi
      `;
      
      await server.executeCommand(`echo '${monitorScript}' > /tmp/login_monitor.sh`);
      await server.executeCommand('chmod +x /tmp/login_monitor.sh');
      await server.executeCommand('/tmp/login_monitor.sh');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/login_monitor.sh /tmp/failed_logins_alert.txt');
    });

    it('should monitor file integrity changes', async () => {
      const server = new LinuxServer('linux-server', 'SEC-SRV');
      
      // Créer une base de référence
      await server.executeCommand('find /etc -type f -name "*.conf" -exec md5sum {} \\; > /tmp/conf_baseline.md5');
      
      // Vérifier l'intégrité
      await server.executeCommand('md5sum -c /tmp/conf_baseline.md5 2>/dev/null | grep -v OK');
      
      // Surveiller les modifications de /etc/passwd
      const passwdCheck = await server.executeCommand('stat /etc/passwd | grep "Modify"');
      
      // Script de surveillance de fichiers sensibles
      const fileMonitor = `#!/bin/bash
SENSITIVE_FILES="/etc/passwd /etc/shadow /etc/sudoers"
for file in $SENSITIVE_FILES; do
    if [ -f "$file" ]; then
        current_hash=$(md5sum "$file" | awk '{print $1}')
        stored_hash=$(grep "$file" /tmp/sensitive_baseline.md5 2>/dev/null | awk '{print $1}')
        
        if [ "$stored_hash" ] && [ "$current_hash" != "$stored_hash" ]; then
            echo "[ALERT] $file has been modified!"
            echo "Old hash: $stored_hash"
            echo "New hash: $current_hash"
        fi
    fi
done
      `;
      
      // Créer la baseline
      await server.executeCommand('md5sum /etc/passwd /etc/shadow /etc/sudoers 2>/dev/null > /tmp/sensitive_baseline.md5');
      
      await server.executeCommand(`echo '${fileMonitor}' > /tmp/file_monitor.sh`);
      await server.executeCommand('chmod +x /tmp/file_monitor.sh');
      await server.executeCommand('/tmp/file_monitor.sh');
      
      // Nettoyer
      await server.executeCommand('rm -f /tmp/conf_baseline.md5 /tmp/sensitive_baseline.md5 /tmp/file_monitor.sh');
    });
  });
});