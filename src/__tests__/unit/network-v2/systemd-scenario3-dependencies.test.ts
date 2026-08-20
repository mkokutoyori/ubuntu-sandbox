import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeUnit(exec: LinuxCommandExecutor, name: string, unitLines: string[]): void {
  const unit = [
    '[Unit]',
    `Description=${name}`,
    ...unitLines,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/usr/bin/${name} -D`,
    'Restart=no',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  exec.vfs.writeFile(`/etc/systemd/system/${name}.service`, unit, 0, 0, 0o022);
}

function buildChain(exec: LinuxCommandExecutor): void {
  writeUnit(exec, 'dbsvc', []);
  writeUnit(exec, 'appsvc', ['Requires=dbsvc.service', 'After=dbsvc.service']);
  writeUnit(exec, 'monsvc', ['Wants=dbsvc.service', 'After=dbsvc.service']);
  exec.execute('systemctl daemon-reload');
}

describe('Scénario 3 — dépendances Requires / Wants / After', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(true);
    exec.attachEventBus(new EventBus(), 'sc3');
    buildChain(exec);
  });

  it('démarrer B (Requires=A) entraîne le démarrage de A', () => {
    exec.execute('systemctl start appsvc');

    expect(exec.execute('systemctl is-active dbsvc').trim()).toBe('active');
    expect(exec.execute('systemctl is-active appsvc').trim()).toBe('active');
  });

  it('After=A garantit que A est journalisé démarré avant B', () => {
    exec.execute('systemctl start appsvc');

    const journal = exec.execute('journalctl');
    const startedA = journal.indexOf('Started dbsvc');
    const startedB = journal.indexOf('Started appsvc');
    expect(startedA).toBeGreaterThanOrEqual(0);
    expect(startedB).toBeGreaterThanOrEqual(0);
    expect(startedA).toBeLessThan(startedB);
  });

  it('arrêter A arrête B (Requires) mais laisse C actif (Wants)', () => {
    exec.execute('systemctl start appsvc');
    exec.execute('systemctl start monsvc');
    expect(exec.execute('systemctl is-active monsvc').trim()).toBe('active');

    exec.execute('systemctl stop dbsvc');

    expect(exec.execute('systemctl is-active dbsvc').trim()).toBe('inactive');
    expect(exec.execute('systemctl is-active appsvc').trim()).toBe('inactive');
    expect(exec.execute('systemctl is-active monsvc').trim()).toBe('active');
  });

  it('la défaillance de A en exploitation arrête B mais pas C', async () => {
    exec.execute('systemctl start appsvc');
    exec.execute('systemctl start monsvc');
    const pidA = exec.serviceMgr.status('dbsvc')!.mainPid!;

    exec.processMgr.kill(pidA, 'SIGKILL');
    await sleep(150);

    expect(exec.serviceMgr.status('dbsvc')!.state).toBe('failed');
    expect(exec.execute('systemctl is-active appsvc').trim()).toBe('inactive');
    expect(exec.execute('systemctl is-active monsvc').trim()).toBe('active');
  });

  it('démarrer C (Wants=A) démarre A mais tolère son absence', () => {
    exec.execute('systemctl start monsvc');
    expect(exec.execute('systemctl is-active dbsvc').trim()).toBe('active');

    exec.execute('systemctl stop monsvc');
    exec.execute('systemctl stop dbsvc');
    exec.execute('rm /etc/systemd/system/dbsvc.service');
    exec.execute('systemctl daemon-reload');

    exec.execute('systemctl start monsvc');
    expect(exec.execute('systemctl is-active monsvc').trim()).toBe('active');
  });

  it('démarrer B échoue si A est introuvable (Requires strict)', () => {
    exec.execute('rm /etc/systemd/system/dbsvc.service');
    exec.execute('systemctl daemon-reload');

    const out = exec.execute('systemctl start appsvc');

    expect(out).toContain('Failed to start');
    expect(exec.execute('systemctl is-active appsvc').trim()).not.toBe('active');
  });

  it('list-dependencies restitue le graphe de B', () => {
    const out = exec.execute('systemctl list-dependencies appsvc');

    expect(out).toContain('appsvc.service');
    expect(out).toContain('dbsvc.service');
  });
});
