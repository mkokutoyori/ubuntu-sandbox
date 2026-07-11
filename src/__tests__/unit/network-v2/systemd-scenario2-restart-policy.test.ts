import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeUnit(
  exec: LinuxCommandExecutor,
  name: string,
  serviceLines: string[],
  unitLines: string[] = [],
): Promise<void> {
  const unit = [
    '[Unit]',
    `Description=${name} daemon`,
    ...unitLines,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/usr/bin/${name} -D`,
    ...serviceLines,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  exec.vfs.writeFile(`/etc/systemd/system/${name}.service`, unit, 0, 0, 0o022);
  await exec.execute('systemctl daemon-reload');
}

describe('Scénario 2 — politiques de redémarrage automatique', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(true);
    exec.attachEventBus(new EventBus(), 'sc2');
  });

  it('Restart=on-failure ne redémarre pas après une sortie propre (code 0)', async () => {
    await writeUnit(exec, 'cleand', ['Restart=on-failure', 'RestartSec=0.05']);
    await exec.execute('systemctl start cleand');
    const pid = exec.serviceMgr.status('cleand')!.mainPid!;

    exec.processMgr.exit(pid, 0);
    await sleep(200);

    expect((await exec.execute('systemctl is-active cleand')).trim()).toBe('inactive');
    expect(await exec.execute('systemctl status cleand')).toContain('code=exited, status=0');
  });

  it('Restart=on-failure redémarre après une sortie en erreur (code non nul)', async () => {
    await writeUnit(exec, 'buggyd', ['Restart=on-failure', 'RestartSec=0.05']);
    await exec.execute('systemctl start buggyd');
    const pid = exec.serviceMgr.status('buggyd')!.mainPid!;

    exec.processMgr.exit(pid, 1);
    await sleep(300);

    const unit = exec.serviceMgr.status('buggyd')!;
    expect(unit.state).toBe('active');
    expect(unit.mainPid).not.toBe(pid);
    const journal = await exec.execute('journalctl -u buggyd');
    expect(journal).toContain('Main process exited, code=exited, status=1');
    expect(journal).toContain('restart counter is at 1');
  });

  it('Restart=on-failure redémarre après un SIGKILL', async () => {
    await writeUnit(exec, 'killd', ['Restart=on-failure', 'RestartSec=0.05']);
    await exec.execute('systemctl start killd');
    const pid = exec.serviceMgr.status('killd')!.mainPid!;

    exec.processMgr.kill(pid, 'SIGKILL');
    await sleep(300);

    expect(exec.serviceMgr.status('killd')!.state).toBe('active');
    expect(exec.serviceMgr.status('killd')!.mainPid).not.toBe(pid);
    expect(await exec.execute('journalctl -u killd')).toContain('code=killed, signal=KILL');
  });

  it('Restart=always redémarre même après une sortie propre', async () => {
    await writeUnit(exec, 'alwaysd', ['Restart=always', 'RestartSec=0.05']);
    await exec.execute('systemctl start alwaysd');
    const pid = exec.serviceMgr.status('alwaysd')!.mainPid!;

    exec.processMgr.exit(pid, 0);
    await sleep(300);

    expect(exec.serviceMgr.status('alwaysd')!.state).toBe('active');
    expect(exec.serviceMgr.status('alwaysd')!.mainPid).not.toBe(pid);
  });

  it('respecte le délai RestartSec avant de relancer', async () => {
    await writeUnit(exec, 'slowd', ['Restart=on-failure', 'RestartSec=0.4']);
    await exec.execute('systemctl start slowd');
    const pid = exec.serviceMgr.status('slowd')!.mainPid!;

    exec.processMgr.kill(pid, 'SIGKILL');
    await sleep(120);

    const during = await exec.execute('systemctl status slowd');
    expect(during).toContain('activating (auto-restart)');
    expect(exec.serviceMgr.status('slowd')!.state).not.toBe('active');

    await sleep(500);
    expect(exec.serviceMgr.status('slowd')!.state).toBe('active');
  });

  it('Restart=on-abnormal ignore un exit code mais réagit à un signal', async () => {
    await writeUnit(exec, 'abnormald', ['Restart=on-abnormal', 'RestartSec=0.05']);
    await exec.execute('systemctl start abnormald');
    const pid1 = exec.serviceMgr.status('abnormald')!.mainPid!;

    exec.processMgr.exit(pid1, 1);
    await sleep(200);
    expect(exec.serviceMgr.status('abnormald')!.state).toBe('failed');

    await exec.execute('systemctl reset-failed abnormald');
    await exec.execute('systemctl start abnormald');
    const pid2 = exec.serviceMgr.status('abnormald')!.mainPid!;
    exec.processMgr.kill(pid2, 'SIGKILL');
    await sleep(200);
    expect(exec.serviceMgr.status('abnormald')!.state).toBe('active');
  });

  it('bloque en failed après StartLimitBurst échecs et exige reset-failed', async () => {
    await writeUnit(
      exec, 'loopd',
      ['Restart=on-failure', 'RestartSec=0.02'],
      ['StartLimitBurst=3', 'StartLimitIntervalSec=30'],
    );
    await exec.execute('systemctl start loopd');

    for (let i = 0; i < 4; i++) {
      const pid = exec.serviceMgr.status('loopd')?.mainPid;
      if (pid !== undefined) exec.processMgr.kill(pid, 'SIGKILL');
      await sleep(150);
    }

    expect(exec.serviceMgr.status('loopd')!.state).toBe('failed');
    const journal = await exec.execute('journalctl -u loopd');
    expect(journal).toContain('Start request repeated too quickly');
    expect((await exec.execute('systemctl is-active loopd')).trim()).toBe('failed');

    const refused = await exec.execute('systemctl start loopd');
    expect(refused).toContain('start-limit-hit');
    expect(exec.serviceMgr.status('loopd')!.state).toBe('failed');

    await exec.execute('systemctl reset-failed loopd');
    await exec.execute('systemctl start loopd');
    await sleep(50);
    expect(exec.serviceMgr.status('loopd')!.state).toBe('active');
  });

  it('journalise chaque tentative avec horodatage et cause', async () => {
    await writeUnit(exec, 'traced', ['Restart=on-failure', 'RestartSec=0.05']);
    await exec.execute('systemctl start traced');

    exec.processMgr.kill(exec.serviceMgr.status('traced')!.mainPid!, 'SIGKILL');
    await sleep(250);
    exec.processMgr.exit(exec.serviceMgr.status('traced')!.mainPid!, 2);
    await sleep(250);

    const journal = await exec.execute('journalctl -u traced');
    expect(journal).toContain('code=killed, signal=KILL');
    expect(journal).toContain('code=exited, status=2');
    expect(journal).toContain('restart counter is at 2');
  });
});
