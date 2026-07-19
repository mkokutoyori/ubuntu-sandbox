/**
 * Scénario 10 — Audit complet de la machine Linux : cohérence processus,
 * fichiers de configuration, ports, et logs.
 *
 * Valide qu'un script d'audit bash natif (linux-audit.sh) produit un
 * rapport structuré et un score de sécurité cohérents avec l'état réel de
 * la machine : sain par défaut, dégradé face à des anomalies contrôlées
 * (UID 0 dupliqué, mot de passe vide, port telnet, permissions
 * anormales). Chaque test pilote une vraie `LinuxServer` via
 * `executeCommand`.
 *
 * Notes de fidélité (cf. scénarios 7 et 9 pour le même constat) :
 * - `/etc/ssh/sshd_config` et `/etc/crontab` sont vérifiés en 644, pas
 *   600 — c'est le défaut réel Ubuntu (et celui de ce simulateur), 600
 *   est une recommandation de durcissement, pas le défaut du paquet.
 * - `pgrep -x rsyslog` échouerait TOUJOURS (le process réel est
 *   `rsyslogd`, sous l'unité systemd `rsyslog`) : on vérifie `rsyslogd`,
 *   sans quoi le script produirait un faux "PROCESSUS MANQUANT"
 *   permanent, contredisant le critère "chaque CRITICAL est une anomalie
 *   vérifiable".
 * - Le script illustratif utilise `grep -c PATTERN file || echo 0` : un
 *   piège bash connu (`grep -c` imprime déjà "0" ET sort en code 1
 *   quand rien ne correspond, donc `|| echo 0` produit "0\n0", cassant
 *   la comparaison numérique `-gt` qui suit). On utilise à la place
 *   `X=$(grep -c ... 2>/dev/null); X=${X:-0}`, le pattern correct.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 10 — audit complet (linux-audit.sh)', () => {
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    await installAudit();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  async function installAudit(): Promise<void> {
    await run(`cat << 'AUDIT' > /usr/local/bin/linux-audit.sh
#!/bin/bash
set -uo pipefail

REPORT="/tmp/audit-report.txt"
SCORE=100

section() {
  echo "" | tee -a "$REPORT"
  echo "====================================" | tee -a "$REPORT"
  echo "  $1" | tee -a "$REPORT"
  echo "====================================" | tee -a "$REPORT"
}

finding() {
  local severity="$1"
  local message="$2"
  echo "[$severity] $message" | tee -a "$REPORT"
  case "$severity" in
    CRITICAL) SCORE=$((SCORE - 20)) ;;
    HIGH)     SCORE=$((SCORE - 10)) ;;
    MEDIUM)   SCORE=$((SCORE - 5))  ;;
    INFO)     : ;;
  esac
}

echo "RAPPORT D'AUDIT LINUX" | tee "$REPORT"
echo "Machine : $(hostname)" | tee -a "$REPORT"
echo "Date    : $(date)" | tee -a "$REPORT"
echo "Kernel  : $(uname -r)" | tee -a "$REPORT"
echo "Uptime  : $(uptime -p)" | tee -a "$REPORT"

section "1. PROCESSUS SYSTEME CLES"
for proc in systemd sshd cron rsyslogd; do
  if pgrep -x "$proc" > /dev/null 2>&1; then
    PID=$(pgrep -x "$proc" | head -1)
    STATE=$(awk '/^State:/ {print $2}' /proc/$PID/status)
    RSS=$(awk '/^VmRSS:/ {print $2" "$3}' /proc/$PID/status)
    finding "INFO" "$proc: OK (PID=$PID, etat=$STATE, RSS=$RSS)"
  else
    finding "CRITICAL" "PROCESSUS MANQUANT: $proc"
  fi
done

ZOMBIES=$(ps -eo stat | grep -c '^Z' 2>/dev/null); ZOMBIES=\${ZOMBIES:-0}
[ "$ZOMBIES" -gt 0 ] && \\
  finding "HIGH" "Processus zombies detectes: $ZOMBIES" || \\
  finding "INFO" "Aucun processus zombie"

section "2. FICHIERS DE CONFIGURATION SENSIBLES"

check_file_perms() {
  local file=$1 expected_perms=$2 expected_owner=$3
  if [ ! -f "$file" ]; then
    finding "HIGH" "FICHIER MANQUANT: $file"
    return
  fi
  local perms owner
  perms=$(stat -c '%a' "$file")
  owner=$(stat -c '%U' "$file")
  if [ "$perms" != "$expected_perms" ] || [ "$owner" != "$expected_owner" ]; then
    finding "HIGH" "PERMISSIONS ANORMALES: $file ($perms/$owner, attendu $expected_perms/$expected_owner)"
  else
    finding "INFO" "OK: $file ($perms, $owner)"
  fi
}

check_file_perms /etc/passwd   644 root
check_file_perms /etc/shadow   640 root
check_file_perms /etc/sudoers  440 root
check_file_perms /etc/ssh/sshd_config 644 root
check_file_perms /etc/crontab  644 root

ROOT_LOGIN=$(grep -i '^PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
[ "\${ROOT_LOGIN:-yes}" = "no" ] && \\
  finding "INFO" "PermitRootLogin: no (correct)" || \\
  finding "HIGH" "PermitRootLogin: \${ROOT_LOGIN:-non defini} (devrait etre no)"

section "3. COMPTES ET PRIVILEGES"

awk -F: '$3 == 0 && $1 != "root" {print "CRITICAL: Compte avec UID=0:", $1}' /etc/passwd | while read line; do
  finding "CRITICAL" "$line"
done

awk -F: '$2 == "" {print $1}' /etc/shadow | while read account; do
  finding "CRITICAL" "Compte sans mot de passe: $account"
done

awk -F: '$3 < 1000 && $1 != "root" && $7 != "/sbin/nologin" && $7 != "/usr/sbin/nologin" && $7 != "/bin/false" && $7 != "" {print $1, $3, $7}' /etc/passwd | while read name uid shell; do
  finding "MEDIUM" "Compte systeme avec shell interactif: $name (UID=$uid, shell=$shell)"
done

section "4. PORTS ET SERVICES RESEAU"

ss -tlnp | awk 'NR>1 {print $4, $NF}' | while read addr_port process; do
  port=$(echo "$addr_port" | grep -oP ':\\K\\d+$')
  case "$port" in
    22)   echo "[INFO] SSH (port 22): $process" ;;
    23)   echo "[CRITICAL] TELNET DETECTE (port 23): $process" ;;
    21)   echo "[HIGH] FTP DETECTE (port 21): $process" ;;
    80)   echo "[INFO] HTTP (port 80): $process" ;;
    443)  echo "[INFO] HTTPS (port 443): $process" ;;
    3306) echo "[MEDIUM] MySQL expose (port 3306): $process" ;;
    5432) echo "[MEDIUM] PostgreSQL expose (port 5432): $process" ;;
    *)    echo "[INFO] Port $port: $process" ;;
  esac
done | tee -a "$REPORT"

section "5. ANOMALIES DANS LES LOGS RECENTS"

SSH_FAILS=$(grep -c 'Failed password\\|Invalid user' /var/log/auth.log 2>/dev/null); SSH_FAILS=\${SSH_FAILS:-0}
[ "$SSH_FAILS" -gt 10 ] && \\
  finding "HIGH" "Nombreuses tentatives SSH echouees: $SSH_FAILS" || \\
  finding "INFO" "Tentatives SSH echouees: $SSH_FAILS"

ROOT_LOGINS=$(grep 'Accepted.*root' /var/log/auth.log 2>/dev/null | wc -l)
[ "$ROOT_LOGINS" -gt 0 ] && \\
  finding "HIGH" "Connexions root directes: $ROOT_LOGINS" || \\
  finding "INFO" "Aucune connexion root directe"

section "RESUME"
echo "Score de securite: $SCORE/100" | tee -a "$REPORT"

if [ "$SCORE" -ge 80 ]; then STATUS="ACCEPTABLE"
elif [ "$SCORE" -ge 60 ]; then STATUS="DEGRADE"
else STATUS="CRITIQUE"
fi
echo "Statut global: $STATUS" | tee -a "$REPORT"

if [ "$SCORE" -lt 100 ]; then exit 1; else exit 0; fi
AUDIT
chmod +x /usr/local/bin/linux-audit.sh`);
  }

  describe('audit sur machine saine', () => {
    it('produit un score de 100 et un statut ACCEPTABLE', async () => {
      await run('/usr/local/bin/linux-audit.sh');
      const code = Number((await run('echo $?')).trim());

      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toContain('Score de securite: 100/100');
      expect(report).toContain('Statut global: ACCEPTABLE');
      expect(code).toBe(0);
    });

    it('rapporte les quatre processus clés OK avec un PID vérifiable dans /proc', async () => {
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toMatch(/\[INFO\] systemd: OK \(PID=\d+/);
      expect(report).toMatch(/\[INFO\] sshd: OK \(PID=\d+/);
      expect(report).toMatch(/\[INFO\] cron: OK \(PID=\d+/);
      expect(report).toMatch(/\[INFO\] rsyslogd: OK \(PID=\d+/);

      const pids = [...report.matchAll(/OK \(PID=(\d+)/g)].map((m) => m[1]);
      expect(pids.length).toBe(4);
      for (const pid of pids) {
        const status = await run(`cat /proc/${pid}/status`);
        expect(status).not.toMatch(/No such file/);
      }
    });

    it('le rapport est auto-suffisant : hostname, date, kernel, uptime présents', async () => {
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toMatch(/Machine : \S+/);
      expect(report).toMatch(/Kernel  : \S+/);
      expect(report).toMatch(/Uptime  : up /);
    });

    it('ne signale aucun compte à UID 0 dupliqué, aucun mot de passe vide', async () => {
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).not.toMatch(/Compte avec UID=0/);
      expect(report).not.toMatch(/Compte sans mot de passe/);
    });
  });

  describe('détection d\'anomalies réelles', () => {
    it('un second compte UID=0 fait chuter le score de 20 points et produit un CRITICAL vérifiable', async () => {
      // Shell non-interactif pour isoler l'anomalie UID=0 seule (un shell
      // interactif déclencherait *aussi* le MEDIUM "shell interactif" —
      // testé séparément ci-dessous).
      await run('echo "intrus:x:0:0:Intrus:/home/intrus:/sbin/nologin" >> /etc/passwd');
      await run('/usr/local/bin/linux-audit.sh');
      const code = Number((await run('echo $?')).trim());
      expect(code).toBe(1);

      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toMatch(/CRITICAL.*Compte avec UID=0: intrus/);
      expect(report).toContain('Score de securite: 80/100');

      // L'anomalie est vérifiable manuellement, sans accès interactif :
      const passwd = await run('grep ":0:" /etc/passwd');
      expect(passwd).toContain('intrus');
    });

    it('un mot de passe vide dans /etc/shadow produit un CRITICAL et fait chuter le score', async () => {
      await run('echo "vide:::19000:0:99999:7:::" >> /etc/shadow');
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toMatch(/CRITICAL.*Compte sans mot de passe: vide/);
      expect(report).toContain('Score de securite: 80/100');
    });

    it('un port telnet (23) en écoute produit un CRITICAL', async () => {
      await run('nc -l -p 23 &');
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toContain('[CRITICAL] TELNET DETECTE (port 23)');
    });

    it('une permission anormale sur /etc/passwd produit un HIGH et fait chuter le score', async () => {
      await run('chmod 666 /etc/passwd');
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toMatch(/HIGH.*PERMISSIONS ANORMALES: \/etc\/passwd \(666\/root, attendu 644\/root\)/);
      expect(report).toContain('Score de securite: 90/100');
    });

    it('un compte système avec shell interactif produit un MEDIUM', async () => {
      await run('useradd -r -s /bin/bash backdoor');
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      expect(report).toMatch(/MEDIUM.*Compte systeme avec shell interactif: backdoor/);
      expect(report).toContain('Score de securite: 95/100');
    });

    it('plusieurs anomalies cumulées produisent un score cohérent et un statut dégradé', async () => {
      await run('echo "intrus:x:0:0:Intrus:/home/intrus:/bin/bash" >> /etc/passwd');
      await run('echo "vide:::19000:0:99999:7:::" >> /etc/shadow');
      await run('chmod 666 /etc/passwd');
      await run('/usr/local/bin/linux-audit.sh');
      const report = await run('cat /tmp/audit-report.txt');
      // "intrus" (UID=0, shell interactif) déclenche à la fois le
      // CRITICAL "UID=0" et le MEDIUM "shell interactif" — un même
      // compte forgé peut légitimement cumuler plusieurs findings.
      // 100 - 20 (UID0) - 20 (mdp vide) - 5 (shell interactif) - 10 (perms) = 45
      expect(report).toContain('Score de securite: 45/100');
      expect(report).toContain('Statut global: CRITIQUE');
    });
  });
});
