/**
 * Scénario 9 — Surveillance des processus clés et détection de dérive par
 * scripts bash natifs.
 *
 * Valide qu'un script bash de surveillance (process-monitor.sh) détecte
 * l'arrêt d'un service clé via `pgrep -x`, journalise avec horodatage, et
 * déclenche une remédiation automatique via `systemctl start`. Chaque test
 * pilote une vraie `LinuxServer` via `executeCommand`.
 *
 * Note de fidélité : le script illustratif du scénario indexe
 * PROCESS_CHECKS par nom de *service* ("sshd", "rsyslog") et appelle
 * `pgrep -x "$name"` / `systemctl start "$name"` avec la même clé. Sur ce
 * simulateur (comme sur un vrai Ubuntu), le nom de processus (`comm`,
 * utilisé par pgrep) et le nom d'unité systemd divergent pour deux des
 * trois services : le binaire sshd tourne sous l'unité `ssh`, et
 * `rsyslogd` (le vrai nom du processus) tourne sous l'unité `rsyslog`.
 * Utiliser le nom d'unité pour pgrep -x échouerait TOUJOURS à trouver ces
 * process (faux positifs permanents), ce qui contredirait le critère de
 * réussite "aucune fausse alerte sur une machine saine". Le script ci-
 * dessous distingue donc explicitement `comm:` (pour pgrep) et `unit:`
 * (pour systemctl) — un script de supervision réel ferait cette même
 * distinction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 9 — surveillance des processus clés (process-monitor.sh)', () => {
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    await installMonitor();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  async function installMonitor(): Promise<void> {
    await run(`cat << 'MONITOR' > /usr/local/bin/process-monitor.sh
#!/bin/bash
set -uo pipefail

LOGFILE="/var/log/process-monitor.log"
ALERT_FILE="/tmp/process-monitor-alerts.txt"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$1] $2" \\
    | tee -a "$LOGFILE"
}

# comm:<nom de processus, pour pgrep -x> unit:<unité systemd> port:<port ou none>
declare -A PROCESS_CHECKS=(
  ["sshd"]="comm:sshd unit:ssh port:22"
  ["cron"]="comm:cron unit:cron port:none"
  ["rsyslog"]="comm:rsyslogd unit:rsyslog port:none"
)

check_process() {
  local key="$1"
  local spec="$2"
  local comm unit expected_port pid

  comm=$(echo "$spec" | grep -oP 'comm:\\K\\S+')
  unit=$(echo "$spec" | grep -oP 'unit:\\K\\S+')
  expected_port=$(echo "$spec" | grep -oP 'port:\\K\\S+')

  pid=$(pgrep -x "$comm" 2>/dev/null | head -1)
  if [ -z "$pid" ]; then
    log "CRITICAL" "PROCESSUS ABSENT: $key"
    echo "$key:absent:$unit" >> "$ALERT_FILE"
    return 1
  fi

  local state
  state=$(awk '/^State:/ {print $2}' /proc/$pid/status 2>/dev/null)
  if [ "$state" = "Z" ]; then
    log "ERROR" "ZOMBIE DETECTE: $key (PID=$pid)"
    echo "$key:zombie:$unit" >> "$ALERT_FILE"
    return 1
  fi

  local rss_kb
  rss_kb=$(awk '/^VmRSS:/ {print $2}' /proc/$pid/status 2>/dev/null)
  if [ "\${rss_kb:-0}" -gt 512000 ]; then
    log "WARN" "MEMOIRE ELEVEE: $key (PID=$pid, RSS=\${rss_kb}KB)"
    echo "$key:memory_high:$unit" >> "$ALERT_FILE"
  fi

  if [ "$expected_port" != "none" ]; then
    if ! ss -tlnp | grep -q ":$expected_port "; then
      log "ERROR" "PORT ABSENT: $key devrait ecouter sur $expected_port"
      echo "$key:port_missing:$expected_port:$unit" >> "$ALERT_FILE"
      return 1
    fi
  fi

  log "INFO" "OK: $key (PID=$pid, etat=$state)"
  return 0
}

remediate() {
  local key="$1"
  local issue="$2"
  local unit="$3"
  log "INFO" "Tentative de remediation: $key ($issue)"

  case "$issue" in
    absent|zombie)
      if systemctl is-enabled "$unit" >/dev/null 2>&1; then
        systemctl start "$unit" && \\
          log "INFO" "Service $unit redemarre avec succes" || \\
          log "ERROR" "Echec du redemarrage de $unit"
      fi
      ;;
    memory_high)
      systemctl reload "$unit" 2>/dev/null || \\
        log "WARN" "Reload impossible pour $unit"
      ;;
  esac
}

> "$ALERT_FILE"
for key in "\${!PROCESS_CHECKS[@]}"; do
  spec="\${PROCESS_CHECKS[$key]}"
  unit=$(echo "$spec" | grep -oP 'unit:\\K\\S+')
  check_process "$key" "$spec" || remediate "$key" "absent" "$unit"
done

ALERT_COUNT=$(wc -l < "$ALERT_FILE")
if [ "$ALERT_COUNT" -gt 0 ]; then
  log "WARN" "$ALERT_COUNT alerte(s) detectee(s)"
  cat "$ALERT_FILE" >> "$LOGFILE"
  exit 1
fi
log "INFO" "Tous les processus OK"
exit 0
MONITOR
chmod +x /usr/local/bin/process-monitor.sh`);
  }

  describe('exécution manuelle sur machine saine', () => {
    it('détecte les trois services (sshd/cron/rsyslogd) sans fausse alerte', async () => {
      await run('/usr/local/bin/process-monitor.sh');
      const code = Number((await run('echo $?')).trim());
      expect(code).toBe(0);

      const log = await run('cat /var/log/process-monitor.log');
      expect(log).toMatch(/OK: sshd/);
      expect(log).toMatch(/OK: cron/);
      expect(log).toMatch(/OK: rsyslog/);
      expect(log).toContain('Tous les processus OK');
      expect(log).not.toContain('CRITICAL');
    });

    it('journalise avec un horodatage précis (YYYY-MM-DD HH:MM:SS)', async () => {
      await run('/usr/local/bin/process-monitor.sh');
      const log = await run('cat /var/log/process-monitor.log');
      expect(log).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\]/);
    });

    it("n'émet aucune fausse alerte sur trois cycles consécutifs", async () => {
      for (let i = 0; i < 3; i++) {
        await run('/usr/local/bin/process-monitor.sh');
        const code = Number((await run('echo $?')).trim());
        expect(code).toBe(0);
      }
      const alerts = await run('cat /tmp/process-monitor-alerts.txt');
      expect(alerts.trim()).toBe('');
    });
  });

  describe('détection et remédiation automatique', () => {
    it('détecte rsyslogd absent après systemctl stop rsyslog, exit code non-zéro', async () => {
      await run('systemctl stop rsyslog');
      expect((await run('pgrep -x rsyslogd')).trim()).toBe('');

      await run('/usr/local/bin/process-monitor.sh');
      const code = Number((await run('echo $?')).trim());
      expect(code).toBe(1);

      const log = await run('cat /var/log/process-monitor.log');
      expect(log).toMatch(/CRITICAL.*PROCESSUS ABSENT: rsyslog/);
    });

    it('la remédiation via systemctl start relance effectivement rsyslogd', async () => {
      await run('systemctl stop rsyslog');
      await run('/usr/local/bin/process-monitor.sh');

      expect((await run('pgrep -x rsyslogd')).trim()).not.toBe('');
      const log = await run('cat /var/log/process-monitor.log');
      expect(log).toMatch(/Service rsyslog redemarre avec succes/);
    });

    it('un second cycle après remédiation ne trouve plus aucune alerte', async () => {
      await run('systemctl stop rsyslog');
      await run('/usr/local/bin/process-monitor.sh');

      await run('/usr/local/bin/process-monitor.sh');
      const code = Number((await run('echo $?')).trim());
      expect(code).toBe(0);
      const alerts = await run('cat /tmp/process-monitor-alerts.txt');
      expect(alerts.trim()).toBe('');
    });
  });

  describe('planification via cron', () => {
    it('le script est exécuté toutes les 5 minutes une fois planifié', async () => {
      await run('(crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/process-monitor.sh") | crontab -');
      await run('rm -f /var/log/process-monitor.log');
      srv.advanceTime(5 * 60 * 1000);
      const log = await run('cat /var/log/process-monitor.log');
      expect(log).toContain('Tous les processus OK');
    });
  });
});
