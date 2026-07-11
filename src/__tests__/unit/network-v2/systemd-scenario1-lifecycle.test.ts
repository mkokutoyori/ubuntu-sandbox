import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

const WANTS_LINK = '/etc/systemd/system/multi-user.target.wants/myapp.service';

async function writeUnit(exec: LinuxCommandExecutor, extraService: string[] = []): Promise<void> {
  const unit = [
    '[Unit]',
    'Description=My custom application',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/bin/myapp --daemon',
    'ExecReload=/bin/kill -HUP $MAINPID',
    ...extraService,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  exec.vfs.writeFile('/etc/systemd/system/myapp.service', unit, 0, 0, 0o022);
  await exec.execute('systemctl daemon-reload');
}

describe('Scénario 1 — cycle de vie complet d\'un service systemd', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(async () => {
    exec = new LinuxCommandExecutor(true);
    exec.attachEventBus(new EventBus(), 'sc1');
    await writeUnit(exec);
  });

  it('charge le unit file après daemon-reload sans le démarrer', async () => {
    const out = await exec.execute('systemctl status myapp');

    expect(out).toContain('myapp.service - My custom application');
    expect(out).toContain('Loaded: loaded (/etc/systemd/system/myapp.service; disabled');
    expect(out).toContain('Active: inactive (dead)');
  });

  it('enable crée le lien symbolique wants sans démarrer le service', async () => {
    const out = await exec.execute('systemctl enable myapp');

    expect(out).toContain('Created symlink');
    expect(out).toContain('/etc/systemd/system/multi-user.target.wants/myapp.service');
    expect(exec.vfs.exists(WANTS_LINK)).toBe(true);
    expect((await exec.execute('systemctl is-enabled myapp')).trim()).toBe('enabled');
    expect((await exec.execute('systemctl is-active myapp')).trim()).toBe('inactive');
  });

  it('start passe le service en active (running) avec un PID cohérent avec ps', async () => {
    await exec.execute('systemctl start myapp');

    const status = await exec.execute('systemctl status myapp');
    expect(status).toContain('Active: active (running)');
    const pid = Number(/Main PID: (\d+)/.exec(status)?.[1]);
    expect(pid).toBeGreaterThan(1);

    const ps = await exec.execute('ps aux');
    const line = ps.split('\n').find((l) => l.includes('/usr/bin/myapp --daemon'));
    expect(line).toBeDefined();
    expect(line).toContain(String(pid));
    expect((await exec.execute('systemctl is-active myapp')).trim()).toBe('active');
  });

  it('restart relance avec un nouveau PID, reload conserve le PID', async () => {
    await exec.execute('systemctl start myapp');
    const pid1 = exec.serviceMgr.status('myapp')!.mainPid!;

    await exec.execute('systemctl restart myapp');
    const pid2 = exec.serviceMgr.status('myapp')!.mainPid!;
    expect(pid2).not.toBe(pid1);

    await exec.execute('systemctl reload myapp');
    const pid3 = exec.serviceMgr.status('myapp')!.mainPid!;
    expect(pid3).toBe(pid2);
    expect((await exec.execute('systemctl is-active myapp')).trim()).toBe('active');
  });

  it('refuse reload sur une unité sans ExecReload', async () => {
    exec.vfs.writeFile('/etc/systemd/system/noreload.service', [
      '[Unit]', 'Description=No reload', '',
      '[Service]', 'Type=simple', 'ExecStart=/usr/bin/noreload', '',
      '[Install]', 'WantedBy=multi-user.target', '',
    ].join('\n'), 0, 0, 0o022);
    await exec.execute('systemctl daemon-reload');
    await exec.execute('systemctl start noreload');

    const out = await exec.execute('systemctl reload noreload');

    expect(out).toContain('Job type reload is not applicable for unit noreload.service.');
  });

  it('stop arrête le processus et le retire de ps sans toucher à enable', async () => {
    await exec.execute('systemctl enable myapp');
    await exec.execute('systemctl start myapp');
    const pid = exec.serviceMgr.status('myapp')!.mainPid!;

    await exec.execute('systemctl stop myapp');

    expect(await exec.execute('systemctl status myapp')).toContain('Active: inactive (dead)');
    expect(await exec.execute('ps aux')).not.toContain('/usr/bin/myapp --daemon');
    expect(exec.processMgr.get(pid)).toBeUndefined();
    expect((await exec.execute('systemctl is-active myapp')).trim()).toBe('inactive');
    expect((await exec.execute('systemctl is-enabled myapp')).trim()).toBe('enabled');
  });

  it('disable supprime le lien symbolique sans arrêter le service', async () => {
    await exec.execute('systemctl enable myapp');
    await exec.execute('systemctl start myapp');

    const out = await exec.execute('systemctl disable myapp');

    expect(out).toContain('Removed');
    expect(exec.vfs.exists(WANTS_LINK)).toBe(false);
    expect((await exec.execute('systemctl is-enabled myapp')).trim()).toBe('disabled');
    expect((await exec.execute('systemctl is-active myapp')).trim()).toBe('active');
  });

  it('un service enabled redémarre au boot, un service disabled non', async () => {
    await exec.execute('systemctl enable myapp');
    await exec.execute('systemctl start myapp');
    const pidBefore = exec.serviceMgr.status('myapp')!.mainPid!;

    await exec.execute('reboot');

    const status = await exec.execute('systemctl status myapp');
    expect(status).toContain('Active: active (running)');
    expect(exec.serviceMgr.status('myapp')!.mainPid).not.toBe(pidBefore);

    await exec.execute('systemctl disable myapp');
    await exec.execute('reboot');
    expect((await exec.execute('systemctl is-active myapp')).trim()).toBe('inactive');
  });
});
