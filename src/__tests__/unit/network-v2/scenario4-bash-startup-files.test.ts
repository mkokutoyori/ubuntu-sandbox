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

describe('Scénario 4 — reproduction littérale du script du scénario', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  const TIME_RE = /\d{2}:\d{2}:\d{2}/;

  it('sauvegarde, instrumentation, sourcing par type de session, listage et restauration', async () => {
    // Sauvegarde préalable
    await run('cp /etc/profile /tmp/profile.bak');
    await run('cp /etc/bash.bashrc /tmp/bash.bashrc.bak');
    await run('[ -f ~/.bashrc ] && cp ~/.bashrc /tmp/bashrc.bak');
    await run('[ -f ~/.bash_profile ] && cp ~/.bash_profile /tmp/bash_profile.bak');

    // Instrumentation avec marqueurs horodatés
    await run('echo \'export SOURCED_PROFILE="$(date +%T) /etc/profile"\' >> /etc/profile');
    await run('echo \'export SOURCED_BASHRC_SYS="$(date +%T) /etc/bash.bashrc"\' >> /etc/bash.bashrc');
    await run('echo \'export SOURCED_BASHRC_USER="$(date +%T) ~/.bashrc"\' >> ~/.bashrc');
    await run('echo \'export SOURCED_BASH_PROFILE="$(date +%T) ~/.bash_profile"\' >> ~/.bash_profile');
    await run('echo \'export SOURCED_PROFILE_D="$(date +%T) /etc/profile.d/*.sh"\' > /etc/profile.d/99-tracer.sh');

    // 1. Login shell interactif (statements joined with `;` — same script
    // as the scenario's heredoc-style block, just on one line: our shell
    // dispatch takes a single command-line string, not a multi-line one).
    const loginOut = await run(
      'bash --login -c \'echo "PROFILE: $SOURCED_PROFILE"; echo "PROFILE_D: $SOURCED_PROFILE_D"; '
      + 'echo "BASH_PROFILE: $SOURCED_BASH_PROFILE"; echo "BASHRC_SYS: $SOURCED_BASHRC_SYS"; '
      + 'echo "BASHRC_USER: $SOURCED_BASHRC_USER"\'',
    );
    expect(loginOut).toMatch(new RegExp(`PROFILE: ${TIME_RE.source} /etc/profile`));
    expect(loginOut).toMatch(new RegExp(`PROFILE_D: ${TIME_RE.source} /etc/profile\\.d/\\*\\.sh`));
    expect(loginOut).toMatch(new RegExp(`BASH_PROFILE: ${TIME_RE.source} ~/\\.bash_profile`));
    expect(loginOut).toMatch(/BASHRC_SYS: *(\n|$)/);
    expect(loginOut).toMatch(/BASHRC_USER: *(\n|$)/);

    // 2. Shell non-login interactif
    const nonLoginOut = await run(
      'bash -i -c \'echo "PROFILE: ${SOURCED_PROFILE:-non sourcé}"; echo "BASHRC_SYS: ${SOURCED_BASHRC_SYS:-non sourcé}"; '
      + 'echo "BASHRC_USER: ${SOURCED_BASHRC_USER:-non sourcé}"\'',
    );
    expect(nonLoginOut).toContain('PROFILE: non sourcé');
    expect(nonLoginOut).toMatch(new RegExp(`BASHRC_SYS: ${TIME_RE.source} /etc/bash\\.bashrc`));
    expect(nonLoginOut).toMatch(new RegExp(`BASHRC_USER: ${TIME_RE.source} ~/\\.bashrc`));

    // 3. Shell non-interactif (script)
    const nonInteractiveOut = await run(
      'bash -c \'echo "PROFILE: ${SOURCED_PROFILE:-non sourcé}"; echo "BASHRC: ${SOURCED_BASHRC_USER:-non sourcé}"\'',
    );
    expect(nonInteractiveOut).toContain('PROFILE: non sourcé');
    expect(nonInteractiveOut).toContain('BASHRC: non sourcé');

    // 4. Shell avec BASH_ENV explicite
    await run('export BASH_ENV=/tmp/env-test.sh');
    await run('echo \'export SOURCED_BASH_ENV="oui"\' > /tmp/env-test.sh');
    const bashEnvOut = await run(`bash -c 'echo "BASH_ENV: ${'${SOURCED_BASH_ENV:-non sourcé}'}"'`);
    expect(bashEnvOut).toContain('BASH_ENV: oui');

    // Vérification de /etc/profile.d/
    const listing = await run("ls -la /etc/profile.d/*.sh 2>/dev/null | awk '{print $NF}'");
    expect(listing).toContain('99-tracer.sh');

    const envDump = await run("bash --login -c 'env | grep SOURCED | sort'");
    const sourcedLines = envDump.split('\n').filter((l) => l.startsWith('SOURCED_'));
    expect(sourcedLines.map((l) => l.split('=')[0]).sort()).toEqual([
      'SOURCED_PROFILE', 'SOURCED_PROFILE_D', 'SOURCED_BASH_PROFILE',
    ].sort());

    // Restauration
    await run('cp /tmp/profile.bak /etc/profile');
    await run('cp /tmp/bash.bashrc.bak /etc/bash.bashrc');
    await run('[ -f /tmp/bashrc.bak ] && cp /tmp/bashrc.bak ~/.bashrc');
    await run('[ -f /tmp/bash_profile.bak ] && cp /tmp/bash_profile.bak ~/.bash_profile');
    await run('rm -f /etc/profile.d/99-tracer.sh');

    expect(await run('cat /etc/profile')).not.toContain('SOURCED_PROFILE');
    expect(await run('cat /etc/bash.bashrc')).not.toContain('SOURCED_BASHRC_SYS');
    expect((await run('test -f /etc/profile.d/99-tracer.sh && echo EXISTS || echo GONE')).trim()).toBe('GONE');
  });
});
