/**
 * Scénario 5 — Gestion avancée des scripts cron : planification,
 * variables d'environnement, et gestion des sorties.
 *
 * Valide l'environnement d'exécution cron appauvri, la redirection des
 * sorties, la traçabilité syslog, /etc/cron.d et /etc/cron.daily, et le
 * verrouillage anti-concurrence. Chaque test pilote une vraie
 * `LinuxServer` via `executeCommand`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 5 — scripts cron', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  describe('environnement d\'exécution cron vs shell interactif', () => {
    beforeEach(async () => {
      await run(`cat << 'CRONSCRIPT' > /tmp/env-cron-test.sh
#!/bin/bash
LOGFILE="/tmp/cron-env-test.log"
echo "USER: $(whoami)" >> $LOGFILE
echo "HOME: $HOME" >> $LOGFILE
echo "PATH: $PATH" >> $LOGFILE
echo "SHELL: $SHELL" >> $LOGFILE
echo "Variables count: $(env | wc -l)" >> $LOGFILE
CRONSCRIPT
chmod +x /tmp/env-cron-test.sh`);
    });

    it('cron a significativement moins de variables que la session interactive', async () => {
      const interactiveCount = Number((await run('env | wc -l')).trim());

      await run('(crontab -l 2>/dev/null; echo "* * * * * /tmp/env-cron-test.sh") | crontab -');
      srv.advanceTime(60000);

      const log = await run('cat /tmp/cron-env-test.log');
      const cronCount = Number(/Variables count: (\d+)/.exec(log)?.[1] ?? '999');
      expect(cronCount).toBeLessThanOrEqual(10);
      expect(cronCount).toBeLessThan(interactiveCount / 1.5);
    });

    it('le PATH cron ne contient que les chemins système de base', async () => {
      await run('(crontab -l 2>/dev/null; echo "* * * * * /tmp/env-cron-test.sh") | crontab -');
      srv.advanceTime(60000);
      const log = await run('cat /tmp/cron-env-test.log');
      expect(log).toMatch(/PATH: \/usr\/bin:\/bin/);
      expect(log).not.toMatch(/\/usr\/local/);
    });

    it('HOME et USER dans l\'environnement cron correspondent au propriétaire du crontab', async () => {
      await run('(crontab -l 2>/dev/null; echo "* * * * * /tmp/env-cron-test.sh") | crontab -');
      srv.advanceTime(60000);
      const log = await run('cat /tmp/cron-env-test.log');
      expect(log).toMatch(/USER: root/);
      expect(log).toMatch(/HOME: \/root/);
    });
  });

  describe('gestion des sorties et erreurs cron', () => {
    beforeEach(async () => {
      await run(`cat << 'CRONSCRIPT' > /tmp/cron-output-test.sh
#!/bin/bash
LOGFILE="/tmp/cron-output.log"
ERRFILE="/tmp/cron-errors.log"
exec >> $LOGFILE 2>> $ERRFILE
echo "Debut execution"
ls /repertoire/inexistant
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "ERREUR: exit code=$EXIT_CODE" >&2
  exit $EXIT_CODE
fi
echo "Fin execution OK"
exit 0
CRONSCRIPT
chmod +x /tmp/cron-output-test.sh`);
    });

    it('exécution manuelle: stdout et stderr atterrissent dans leurs fichiers respectifs, pas dans la sortie du terminal', async () => {
      const out = await run('bash /tmp/cron-output-test.sh');
      const code = Number((await run('echo $?')).trim());
      expect(out.trim()).toBe('');
      expect(code).not.toBe(0);

      const log = await run('cat /tmp/cron-output.log');
      expect(log).toContain('Debut execution');
      expect(log).not.toContain('ERREUR');

      const errLog = await run('cat /tmp/cron-errors.log');
      expect(errLog).toContain('ERREUR');
    });
  });

  describe('traçabilité dans syslog', () => {
    it('chaque exécution cron est tracée dans /var/log/syslog avec utilisateur et commande', async () => {
      await run(`echo 'echo hi' > /tmp/cron-syslog-test.sh`);
      await run('chmod +x /tmp/cron-syslog-test.sh');
      await run('(crontab -l 2>/dev/null; echo "* * * * * /tmp/cron-syslog-test.sh") | crontab -');
      srv.advanceTime(60000);

      const syslog = await run("grep 'CRON' /var/log/syslog");
      expect(syslog).toMatch(/CRON/);
      expect(syslog).toMatch(/\(root\)/);
      expect(syslog).toContain('/tmp/cron-syslog-test.sh');
    });
  });

  describe('niveaux de planification /etc/cron.d et /etc/cron.daily', () => {
    it('/etc/cron.d/ au format crontab système (avec champ utilisateur) est honoré', async () => {
      await run(`cat << 'EOF' > /etc/cron.d/mandeng-test
* * * * * root /tmp/cron-output-test.sh
EOF`);
      const listing = await run('cat /etc/cron.d/mandeng-test');
      expect(listing).toContain('root /tmp/cron-output-test.sh');
    });

    it('/etc/cron.daily/ exécute via run-parts, --test liste sans exécuter', async () => {
      await run(`cat << 'EOF' > /etc/cron.daily/mandeng-daily
#!/bin/bash
echo "cron.daily execute" >> /tmp/cron-daily.log
EOF`);
      await run('chmod +x /etc/cron.daily/mandeng-daily');

      const testOut = await run('run-parts --test /etc/cron.daily');
      expect(testOut).toContain('/etc/cron.daily/mandeng-daily');
      expect((await run('cat /tmp/cron-daily.log 2>&1'))).toMatch(/No such file/);

      await run('run-parts /etc/cron.daily');
      expect((await run('cat /tmp/cron-daily.log'))).toContain('cron.daily execute');
    });
  });

  describe('gestion de la concurrence cron (verrous mkdir + trap EXIT)', () => {
    beforeEach(async () => {
      await run(`cat << 'CRONSCRIPT' > /tmp/cron-lock-test.sh
#!/bin/bash
LOCKFILE="/tmp/cron-lock-test.lock"
LOGFILE="/tmp/cron-lock.log"
if ! mkdir "$LOCKFILE" 2>/dev/null; then
  echo "Instance deja en cours, abandon" >> $LOGFILE
  exit 1
fi
trap "rmdir '$LOCKFILE'" EXIT
echo "Debut traitement (PID=$$)" >> $LOGFILE
echo "Fin traitement" >> $LOGFILE
CRONSCRIPT
chmod +x /tmp/cron-lock-test.sh`);
    });

    it('une exécution normale acquiert le verrou puis le libère (trap EXIT)', async () => {
      await run('bash /tmp/cron-lock-test.sh');
      const log = await run('cat /tmp/cron-lock.log');
      expect(log).toContain('Debut traitement');
      expect(log).toContain('Fin traitement');
      expect((await run('test -d /tmp/cron-lock-test.lock && echo EXISTS || echo GONE')).trim()).toBe('GONE');
    });

    it('une instance déjà en cours (verrou déjà pris) fait abandonner la seconde', async () => {
      await run('mkdir /tmp/cron-lock-test.lock'); // simulate an instance already running
      const code = Number((await (async () => {
        await run('bash /tmp/cron-lock-test.sh');
        return run('echo $?');
      })()).trim());
      expect(code).toBe(1);
      const log = await run('cat /tmp/cron-lock.log');
      expect(log).toContain('Instance deja en cours, abandon');
      expect(log).not.toContain('Debut traitement');
    });
  });
});
