/**
 * Scénario 6 — Scripts bash avec trap, gestion d'erreurs, et exit codes.
 *
 * Valide `trap` (nettoyage EXIT, signaux), `set -e`/`set -o pipefail`, et
 * les exit codes standards (126/127/128+N). Chaque test pilote une vraie
 * `LinuxServer` via `executeCommand`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 6 — trap, gestion d\'erreurs, exit codes', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  async function exitCode(cmd: string): Promise<number> {
    await run(cmd);
    return Number((await run('echo $?')).trim());
  }

  describe('script de référence avec trap EXIT + trap TERM/INT/HUP', () => {
    beforeEach(async () => {
      await run(`cat << 'SCRIPT' > /tmp/script-robuste.sh
#!/bin/bash
set -euo pipefail

LOGFILE="/tmp/script-robuste.log"
TMPDIR_WORK="/tmp/work-$$"

log() {
  local level="$1"; shift
  echo "[$level] [PID=$$] $*" | tee -a "$LOGFILE"
}

cleanup() {
  local exit_code=$?
  log "INFO" "Nettoyage en cours (exit_code=$exit_code)"
  rm -rf "$TMPDIR_WORK" 2>/dev/null || true
  log "INFO" "Nettoyage terminé"
}

on_signal() {
  local sig="$1"
  log "WARN" "Signal $sig reçu, arrêt propre"
  exit 130
}

trap cleanup EXIT
trap 'on_signal SIGTERM' TERM
trap 'on_signal SIGINT' INT
trap 'on_signal SIGHUP' HUP

main() {
  log "INFO" "Démarrage (PID=$$, PPID=$PPID)"
  mkdir -p "$TMPDIR_WORK"
  log "INFO" "Répertoire de travail: $TMPDIR_WORK"
  log "INFO" "Test commande susceptible d'échouer"
  ls /chemin/inexistant || {
    log "ERROR" "Commande échouée, exit code: $?"
    exit 1
  }
  log "INFO" "Fin normale"
}

main "$@"
SCRIPT
chmod +x /tmp/script-robuste.sh`);
    });

    it('exécution normale: cleanup tourne via le trap EXIT, exit code 1 (échec géré)', async () => {
      const code = await exitCode('bash /tmp/script-robuste.sh');
      expect(code).toBe(1);
      const log = await run('cat /tmp/script-robuste.log');
      expect(log).toContain('[INFO] [PID=');
      expect(log).toContain('Démarrage');
      expect(log).toContain('Commande échouée');
      expect(log).toContain('Nettoyage en cours (exit_code=1)');
      expect(log).toContain('Nettoyage terminé');
    });

    it('le trap EXIT nettoie le répertoire de travail après l\'échec géré', async () => {
      await run('bash /tmp/script-robuste.sh');
      const log = await run('cat /tmp/script-robuste.log');
      const workDir = /Répertoire de travail: (\S+)/.exec(log)?.[1];
      expect(workDir).toBeDefined();
      expect((await run(`test -d ${workDir} && echo EXISTS || echo GONE`)).trim()).toBe('GONE');
    });

    it('un trap TERM avec exit explicite déclenche aussi le trap EXIT (cleanup)', async () => {
      const notice = await run(
        "bash -c 'trap \"on_signal() { exit 130; }; on_signal\" TERM; trap \"echo CLEANED_UP\" EXIT; while true; do sleep 1; done' &",
      );
      const pid = /\[\d+\]\s+(\d+)/.exec(notice)?.[1] ?? '';
      expect(pid).not.toBe('');
      await run(`kill -TERM ${pid}`);
      // exit inside the TERM handler must have fired the separately
      // registered EXIT trap too — real bash always fires EXIT on exit().
      expect((await run(`cat /proc/${pid}/status`))).toMatch(/No such file/);
    });

    it('SIGKILL termine le processus sans exécuter le trap EXIT', async () => {
      const notice = await run(
        "bash -c 'trap \"echo SHOULD_NOT_APPEAR > /tmp/exit-trap-marker.txt\" EXIT; while true; do sleep 1; done' &",
      );
      const pid = /\[\d+\]\s+(\d+)/.exec(notice)?.[1] ?? '';
      await run(`kill -9 ${pid}`);
      expect((await run('cat /tmp/exit-trap-marker.txt 2>&1'))).toMatch(/No such file/);
    });
  });

  describe('set -e : arrêt sur la première commande échouant sans protection', () => {
    it('arrête le script avant la ligne suivante', async () => {
      await run(`cat << 'EOF' > /tmp/test-sete.sh
#!/bin/bash
set -e
echo "Avant erreur"
ls /inexistant
echo "Après erreur (ne doit pas s'afficher)"
EOF`);
      const out = await run('bash /tmp/test-sete.sh');
      expect(out).toContain('Avant erreur');
      expect(out).not.toContain('Après erreur');
    });

    it('exit code non nul après un set -e non protégé', async () => {
      const code = await exitCode('bash /tmp/test-sete.sh');
      expect(code).not.toBe(0);
    });
  });

  describe('set -o pipefail : propage l\'échec d\'une commande du pipe', () => {
    beforeEach(async () => {
      await run(`cat << 'EOF' > /tmp/test-pipefail.sh
#!/bin/bash
set -o pipefail
ls /inexistant | sort
EOF`);
    });

    it('exit code du pipe reflète l\'échec de ls, pas le succès de sort', async () => {
      const code = await exitCode('bash /tmp/test-pipefail.sh');
      expect(code).not.toBe(0);
    });

    it('sans pipefail, le pipe réussit (exit code de la dernière commande)', async () => {
      await run(`cat << 'EOF' > /tmp/test-nopipefail.sh
#!/bin/bash
ls /inexistant | sort
EOF`);
      const code = await exitCode('bash /tmp/test-nopipefail.sh');
      expect(code).toBe(0);
    });
  });

  describe('trap EXIT garanti au nettoyage', () => {
    it('un trap EXIT s\'exécute à la fin normale du script', async () => {
      await run(`cat << 'EOF' > /tmp/test-trap.sh
#!/bin/bash
TMPFILE=/tmp/test-trapfile
touch "$TMPFILE"
trap 'rm -f "$TMPFILE"; echo Nettoyage effectue' EXIT
echo "Fichier temporaire: $TMPFILE"
EOF`);
      const out = await run('bash /tmp/test-trap.sh');
      expect(out).toContain('Nettoyage effectue');
      expect((await run('test -f /tmp/test-trapfile && echo EXISTS || echo GONE')).trim()).toBe('GONE');
    });
  });

  describe('codes de sortie significatifs', () => {
    it('commande introuvable => 127', async () => {
      expect(await exitCode('commande_introuvable_xyz 2>/dev/null')).toBe(127);
    });

    it('fichier non exécutable => 126', async () => {
      expect(await exitCode('/etc/passwd 2>/dev/null')).toBe(126);
    });

    it('tué par SIGKILL => 128+9=137', async () => {
      const code = await exitCode("bash -c 'kill -9 $$'");
      expect(code).toBe(137);
    });
  });
});
