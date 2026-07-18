/**
 * Scénario 4 — Scripts bash au démarrage : /etc/profile, /etc/bash.bashrc,
 * et ordre d'exécution selon le type de session (login / non-login,
 * interactif / non-interactif). Chaque test pilote une vraie `LinuxServer`
 * via `executeCommand`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 4 — fichiers de démarrage bash', () => {
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
    // Instrument each startup file with a traceable marker, like the
    // scenario's own script does.
    await run('echo \'export SOURCED_PROFILE=yes\' >> /etc/profile');
    await run('echo \'export SOURCED_PROFILE_D=yes\' > /etc/profile.d/99-tracer.sh');
    await run('echo \'export SOURCED_BASHRC_SYS=yes\' >> /etc/bash.bashrc');
    await run('echo \'export SOURCED_BASH_PROFILE=yes\' >> ~/.bash_profile');
    await run('echo \'export SOURCED_BASHRC_USER=yes\' >> ~/.bashrc');
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  it('un login shell source /etc/profile, /etc/profile.d/*.sh puis ~/.bash_profile — pas ~/.bashrc directement', async () => {
    const out = await run(
      "bash --login -c 'echo P=$SOURCED_PROFILE D=$SOURCED_PROFILE_D BP=$SOURCED_BASH_PROFILE BR=${SOURCED_BASHRC_USER:-unset}'",
    );
    expect(out).toContain('P=yes');
    expect(out).toContain('D=yes');
    expect(out).toContain('BP=yes');
    expect(out).toContain('BR=unset');
  });

  it('un shell non-login interactif source /etc/bash.bashrc et ~/.bashrc — pas /etc/profile', async () => {
    const out = await run(
      "bash -i -c 'echo SYS=$SOURCED_BASHRC_SYS USR=$SOURCED_BASHRC_USER P=${SOURCED_PROFILE:-unset}'",
    );
    expect(out).toContain('SYS=yes');
    expect(out).toContain('USR=yes');
    expect(out).toContain('P=unset');
  });

  it('un shell non-interactif ne source aucun fichier de démarrage', async () => {
    const out = await run(
      "bash -c 'echo P=${SOURCED_PROFILE:-unset} BR=${SOURCED_BASHRC_USER:-unset}'",
    );
    expect(out).toContain('P=unset');
    expect(out).toContain('BR=unset');
  });

  it('BASH_ENV est sourcé même pour un shell non-interactif', async () => {
    await run("echo 'export SOURCED_BASH_ENV=yes' > /tmp/env-test.sh");
    await run('export BASH_ENV=/tmp/env-test.sh');
    const out = await run("bash -c 'echo E=${SOURCED_BASH_ENV:-unset}'");
    expect(out).toContain('E=yes');
  });

  it('/etc/profile.d/*.sh sont listés et sourcés dans l\'ordre alphabétique', async () => {
    await run("echo 'export TRACER_A=1' > /etc/profile.d/10-a.sh");
    await run("echo 'export TRACER_B=A$TRACER_A' > /etc/profile.d/20-b.sh");
    const out = await run("bash --login -c 'echo A=$TRACER_A B=$TRACER_B'");
    expect(out).toContain('A=1');
    expect(out).toContain('B=A1');
  });
});
