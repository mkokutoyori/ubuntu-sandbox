/**
 * ufw app profiles ← VFS — PRD-Iptables-UFW.md §2.1 objectif B.4 (Phase 6).
 *
 * Before this fix, `ufw app list`/`app info`/`allow <Profile>` read from a
 * hardcoded static object in LinuxFirewallManager.ts, completely divorced
 * from the `/etc/ufw/applications.d/*` files it was also (separately)
 * seeding into the VFS for display purposes via `cat`/`ls`. Adding a new
 * profile file to that directory — which is exactly how real ufw discovers
 * applications — had zero effect on `ufw app` output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('ufw app profiles read from /etc/ufw/applications.d/', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  it('lists a brand-new profile file with no code change, purely by dropping it in applications.d', async () => {
    await server.executeCommand(
      "cat > /etc/ufw/applications.d/myapp <<'EOF'\n" +
      '[MyApp]\n' +
      'title=My Custom App\n' +
      'description=A custom application profile.\n' +
      'ports=9090/tcp\n' +
      'EOF'
    );

    const list = await server.executeCommand('ufw app list');
    expect(list).toContain('MyApp');
  });

  it('shows info for a dynamically-added profile', async () => {
    await server.executeCommand(
      "cat > /etc/ufw/applications.d/myapp <<'EOF'\n" +
      '[MyApp]\n' +
      'title=My Custom App\n' +
      'description=A custom application profile.\n' +
      'ports=9090/tcp\n' +
      'EOF'
    );

    const info = await server.executeCommand('ufw app info MyApp');
    expect(info).toContain('Profile: MyApp');
    expect(info).toContain('Title: My Custom App');
    expect(info).toContain('9090/tcp');
  });

  it('allows a dynamically-added profile as a rule target', async () => {
    await server.executeCommand(
      "cat > /etc/ufw/applications.d/myapp <<'EOF'\n" +
      '[MyApp]\n' +
      'title=My Custom App\n' +
      'description=A custom application profile.\n' +
      'ports=9090/tcp\n' +
      'EOF'
    );

    const out = await server.executeCommand('ufw allow MyApp');
    expect(out).toContain('Rule added');

    await server.executeCommand('ufw enable');
    const status = await server.executeCommand('ufw status');
    expect(status).toContain('9090/tcp');
  });

  it('supports multiple profiles defined in a single applications.d file', async () => {
    await server.executeCommand(
      "cat > /etc/ufw/applications.d/mystack <<'EOF'\n" +
      '[Stack A]\n' +
      'title=Stack A\n' +
      'description=First profile in the file.\n' +
      'ports=1111/tcp\n' +
      '\n' +
      '[Stack B]\n' +
      'title=Stack B\n' +
      'description=Second profile in the file.\n' +
      'ports=2222/tcp\n' +
      'EOF'
    );

    const list = await server.executeCommand('ufw app list');
    expect(list).toContain('Stack A');
    expect(list).toContain('Stack B');
  });

  it('still lists and serves the built-in seeded profiles (OpenSSH) unaffected by new files', async () => {
    await server.executeCommand(
      "cat > /etc/ufw/applications.d/myapp <<'EOF'\n" +
      '[MyApp]\n' +
      'title=My Custom App\n' +
      'description=A custom application profile.\n' +
      'ports=9090/tcp\n' +
      'EOF'
    );

    const list = await server.executeCommand('ufw app list');
    expect(list).toContain('OpenSSH');
    expect(list).toContain('MyApp');

    const info = await server.executeCommand('ufw app info OpenSSH');
    expect(info).toContain('Profile: OpenSSH');
    expect(info).toContain('22/tcp');
  });
});
