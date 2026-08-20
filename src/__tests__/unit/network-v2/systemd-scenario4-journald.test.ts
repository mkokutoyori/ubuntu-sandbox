import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

function writeUnit(exec: LinuxCommandExecutor, name: string): void {
  const unit = [
    '[Unit]', `Description=${name}`, '',
    '[Service]', 'Type=simple', `ExecStart=/usr/bin/${name} -D`, '',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
  exec.vfs.writeFile(`/etc/systemd/system/${name}.service`, unit, 0, 0, 0o022);
}

function jsonEntries(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Scénario 4 — journald : collecte structurée et filtrage', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(true);
    exec.attachEventBus(new EventBus(), 'sc4');
    writeUnit(exec, 'appa');
    writeUnit(exec, 'appb');
    exec.execute('systemctl daemon-reload');
    exec.execute('systemctl start appa');
    exec.execute('systemctl start appb');
  });

  it('journalctl -u ne restitue que les entrées de l\'unité demandée', () => {
    const onlyA = exec.execute('journalctl -u appa');

    expect(onlyA).toContain('appa');
    expect(onlyA).not.toContain('appb');
  });

  it('journalctl -p err ne retourne que ERROR et plus grave', () => {
    exec.execute('logger -p user.debug "niveau DEBUG visible"');
    exec.execute('logger -p user.info "niveau INFO visible"');
    exec.execute('logger -p user.warning "niveau WARNING visible"');
    exec.execute('logger -p user.err "niveau ERROR visible"');
    exec.execute('logger -p user.crit "niveau CRITICAL visible"');

    const out = exec.execute('journalctl -p err');

    expect(out).toContain('niveau ERROR visible');
    expect(out).toContain('niveau CRITICAL visible');
    expect(out).not.toContain('niveau WARNING visible');
    expect(out).not.toContain('niveau INFO visible');
    expect(out).not.toContain('niveau DEBUG visible');
  });

  it('filtre --since / --until sur une fenêtre horaire précise', () => {
    exec.execute('logger "message dans la fenêtre"');

    const all = exec.execute('journalctl --since "2020-01-01 00:00:00"');
    expect(all).toContain('message dans la fenêtre');

    const none = exec.execute('journalctl --until "2020-01-01 00:00:00" -q');
    expect(none).not.toContain('message dans la fenêtre');

    const windowed = exec.execute(
      'journalctl --since "2020-01-01 00:00:00" --until "2099-01-01 00:00:00"',
    );
    expect(windowed).toContain('message dans la fenêtre');
  });

  it('journalctl _PID= corrèle les messages d\'un processus précis', () => {
    exec.execute('logger "message du shell"');
    const entries = jsonEntries(exec.execute('journalctl -o json'));
    const target = entries.find((e) => String(e.MESSAGE).includes('message du shell'))!;
    const pid = target._PID;
    expect(pid).toBeDefined();

    const filtered = exec.execute(`journalctl _PID=${pid}`);

    expect(filtered).toContain('message du shell');
    const other = entries.find((e) => e._PID !== undefined && e._PID !== pid);
    if (other) expect(filtered).not.toContain(String(other.MESSAGE));
  });

  it('journalctl -o json expose les champs structurés cohérents', () => {
    exec.execute('logger -p user.err "erreur structurée"');

    const entries = jsonEntries(exec.execute('journalctl -o json'));
    const entry = entries.find((e) => String(e.MESSAGE).includes('erreur structurée'))!;

    expect(entry).toBeDefined();
    expect(Number(entry.PRIORITY)).toBe(3);
    expect(Number(entry._PID)).toBeGreaterThan(0);
    expect(entry.__REALTIME_TIMESTAMP).toBeDefined();

    const unitEntry = entries.find((e) => e._SYSTEMD_UNIT === 'appa.service');
    expect(unitEntry).toBeDefined();
  });

  it('corrèle un ID de transaction à travers plusieurs services', () => {
    exec.execute('logger -t appa "TXN-4242 étape de préparation"');
    exec.execute('logger -t appb "TXN-4242 étape de validation"');
    exec.execute('logger -t appb "TXN-9999 autre transaction"');

    const journal = exec.execute('journalctl');
    const txnLines = journal.split('\n').filter((line) => line.includes('TXN-4242'));

    expect(txnLines).toHaveLength(2);
    expect(txnLines.some((l) => l.includes('appa'))).toBe(true);
    expect(txnLines.some((l) => l.includes('appb'))).toBe(true);
  });

  it('conserve les entrées après reboot quand Storage=persistent', () => {
    exec.vfs.writeFile('/etc/systemd/journald.conf', '[Journal]\nStorage=persistent\n', 0, 0, 0o022);
    exec.execute('logger "entrée avant redémarrage"');

    exec.execute('reboot');

    expect(exec.execute('journalctl')).toContain('entrée avant redémarrage');
  });
});
