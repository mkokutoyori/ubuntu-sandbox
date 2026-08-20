/**
 * Secure small-business architecture — end-to-end UI defect sweep.
 * ----------------------------------------------------------------
 * Builds a realistic, *security-hardened* SMB topology entirely through the
 * real browser UI / store and then probes it from the operator's point of
 * view. The goal is NOT to prove the simulator works — it is to surface
 * everything that does NOT: broken UI affordances, vendor command gaps,
 * connectivity that never crosses the cable, and security features that the
 * CLI accepts but does not actually enforce.
 *
 * Every probe appends a structured finding (area + severity + expected vs
 * actual). The suite stays green on minor/expected gaps so the full report is
 * always produced; it only hard-fails on blockers that make the UI unusable.
 * The machine-readable report lands in test-results/smb-defect-report.{json,md}.
 *
 *                 ┌─────────────┐   172.16.0.0/30   ┌──────────────┐
 *   VLAN10 users  │  R-EDGE      │═══════════════════│  R-CORE      │ VLAN20 srv
 *   10.10.10.0/24 │ Cisco IOS    │                   │ Huawei VRP   │ 10.20.20.0/24
 *                 └──────┬───────┘                   └──────┬───────┘
 *                  Fa0/24│                             G0/0/24│
 *                 ┌──────┴───────┐                   ┌───────┴──────┐
 *                 │ SW-USERS     │                   │ SW-SRV       │
 *                 │ Cisco L2     │                   │ Huawei L2    │
 *                 └──┬────────┬──┘                   └──┬────────┬──┘
 *           LinuxPC ─┘        └─ WindowsPC   LinuxServer┘        └─ WindowsServer
 *          .11                  .12              .21                 .22
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

// ── Findings recorder ────────────────────────────────────────────────────
type Area = 'UI' | 'L2' | 'L3' | 'security' | 'vendor' | 'build';
type Severity = 'blocker' | 'major' | 'minor' | 'ok';

interface Finding {
  id: string;
  area: Area;
  severity: Severity;
  expected: string;
  actual: string;
  detail?: unknown;
}

const FINDINGS: Finding[] = [];
function record(f: Finding): void {
  FINDINGS.push(f);
  console.log(`SMB[${f.severity.toUpperCase()}] ${f.area} · ${f.id} :: ${f.actual}`);
}
/** Record + return whether the observation matched expectation. */
function check(
  id: string, area: Area, ok: boolean,
  expected: string, actual: string,
  failSeverity: Severity = 'major', detail?: unknown,
): boolean {
  record({ id, area, severity: ok ? 'ok' : failSeverity, expected, actual, detail });
  return ok;
}

// ── Topology handle (filled by the build step, reused by every probe) ─────
interface Topo {
  rEdge: string;   // Cisco router
  rCore: string;   // Huawei router
  swUsers: string; // Cisco switch
  swSrv: string;   // Huawei switch
  linuxPc: string;
  winPc: string;
  linuxSrv: string;
  winSrv: string;
}
let topo: Topo;
let page: Page;

// ── Generic UI / store helpers ───────────────────────────────────────────
type StoreState = {
  addDevice(t: string, x: number, y: number): { id: string };
  removeDevice(id: string): void;
  deviceInstances: Map<string, Record<string, unknown>>;
  connections: unknown[];
  addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
};
async function waitForApp(p: Page): Promise<void> {
  // The dev server's first request triggers a full Vite transform, which can
  // take far longer than the default navigation timeout on a cold start.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await p.goto('/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await p.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 30_000 });
      await expect(p.locator('h2').filter({ hasText: 'Equipment' })).toBeVisible({ timeout: 15_000 });
      return;
    } catch (e) {
      lastErr = e;
      await p.waitForTimeout(2_000);
    }
  }
  throw lastErr;
}

/** Run a list of CLI commands straight on a device instance; return outputs. */
async function applyConfig(deviceId: string, cmds: string[]): Promise<string[]> {
  return page.evaluate(async ({ deviceId, cmds }) => {
    const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const dev = st.getState().deviceInstances.get(deviceId) as Record<string, unknown> | undefined;
    if (!dev) return ['__NO_DEVICE__'];
    const exec = dev.executeCommand as ((c: string) => Promise<string> | string) | undefined;
    if (!exec) return ['__NO_EXEC__'];
    const out: string[] = [];
    for (const c of cmds) out.push(String(await Promise.resolve(exec.call(dev, c))));
    return out;
  }, { deviceId, cmds } as unknown as Record<string, never>) as Promise<string[]>;
}

/** Single command convenience. */
async function exec1(deviceId: string, cmd: string): Promise<string> {
  return (await applyConfig(deviceId, [cmd]))[0];
}

/** CLI responses that signal the simulator rejected / didn't understand a line. */
const CLI_ERROR_RE = /% (Invalid|Incomplete|Ambiguous|Unrecognized|Unknown)|Error:|Unrecognized command|command not found|not yet implemented|is not recognized/i;
function rejectedLines(cmds: string[], outs: string[]): Array<{ cmd: string; out: string }> {
  const bad: Array<{ cmd: string; out: string }> = [];
  cmds.forEach((c, i) => {
    const o = outs[i] ?? '';
    if (CLI_ERROR_RE.test(o)) bad.push({ cmd: c, out: o.split('\n').slice(0, 2).join(' ⏎ ') });
  });
  return bad;
}

// ── Terminal-modal helpers (drive the real DOM) ──────────────────────────
async function openTerminal(deviceId: string): Promise<boolean> {
  const node = page.locator(`[data-device-id="${deviceId}"]`).first();
  try {
    await node.dblclick({ timeout: 6_000 });
    await page.locator('[data-testid="terminal-modal"]').first().waitFor({ state: 'visible', timeout: 8_000 });
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}
async function closeTerminal(): Promise<void> {
  const close = page.locator('[data-testid="terminal-modal"] button[title="Close"]').first();
  if (await close.count()) await close.click().catch(() => {});
  await page.waitForTimeout(250);
}
async function termType(cmd: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(cmd);
  await input.press('Enter');
  await page.waitForTimeout(350);
}
async function termText(): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').first().innerText()).trim();
}

// ── Vendor-correct, security-hardened config blocks ──────────────────────
const CISCO_ROUTER = (host: string, lanIp: string, wanIp: string, peer: string, remoteLan: string): string[] => [
  'enable', 'configure terminal',
  `hostname ${host}`,
  'ip domain-name acme.local',
  'username admin privilege 15 secret S3cure!Pass',
  'enable secret En@bleS3cret',
  'service password-encryption',
  'crypto key generate rsa modulus 1024',
  'ip ssh version 2',
  'line vty 0 4', 'login local', 'transport input ssh', 'exec-timeout 5 0', 'exit',
  'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
  'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
  `ip route ${remoteLan} 255.255.255.0 ${peer}`,
  'access-list 100 permit ip 10.10.10.0 0.0.0.255 10.20.20.0 0.0.0.255',
  'access-list 100 permit icmp any any',
  'access-list 100 deny ip any any',
  'interface GigabitEthernet0/0', 'ip access-group 100 in', 'end',
];

const CISCO_SWITCH = (host: string): string[] => [
  'enable', 'configure terminal',
  `hostname ${host}`,
  'ip domain-name acme.local',
  'username admin privilege 15 secret S3cure!Pass',
  'enable secret En@bleS3cret',
  'service password-encryption',
  'vlan 10', 'name USERS', 'exit',
  'crypto key generate rsa modulus 1024',
  'ip ssh version 2',
  'line vty 0 4', 'login local', 'transport input ssh', 'exit',
  'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
  'switchport port-security', 'switchport port-security maximum 1',
  'switchport port-security violation shutdown', 'exit',
  'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10',
  'switchport port-security', 'switchport port-security maximum 1',
  'switchport port-security violation shutdown', 'exit',
  'interface FastEthernet0/24', 'switchport mode access', 'switchport access vlan 10', 'end',
];

const HUAWEI_ROUTER = (host: string, lanIp: string, wanIp: string, peer: string, remoteLan: string): string[] => [
  'system-view',
  `sysname ${host}`,
  'aaa',
  'local-user admin password irreversible-cipher S3cure!Pass',
  'local-user admin privilege level 15',
  'local-user admin service-type ssh',
  'quit',
  'rsa local-key-pair create',
  'stelnet server enable',
  'ssh user admin authentication-type password',
  'ssh user admin service-type stelnet',
  'user-interface vty 0 4',
  'authentication-mode aaa',
  'protocol inbound ssh',
  'quit',
  'interface GigabitEthernet0/0/0', `ip address ${lanIp} 255.255.255.0`, 'undo shutdown', 'quit',
  'interface GigabitEthernet0/0/1', `ip address ${wanIp} 255.255.255.252`, 'undo shutdown', 'quit',
  `ip route-static ${remoteLan} 255.255.255.0 ${peer}`,
  'quit',
];

const HUAWEI_SWITCH = (host: string): string[] => [
  'system-view',
  `sysname ${host}`,
  'vlan 20', 'quit',
  'aaa',
  'local-user admin password irreversible-cipher S3cure!Pass',
  'local-user admin privilege level 15',
  'local-user admin service-type ssh',
  'quit',
  'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
  'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 20', 'quit',
  'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 20', 'quit',
  'interface GigabitEthernet0/0/24', 'port link-type access', 'port default vlan 20', 'quit',
  'quit',
];

const LINUX_HOST = (ip: string, gw: string): string[] => [
  `ifconfig eth0 ${ip} netmask 255.255.255.0`,
  `route add default gw ${gw}`,
];
const WINDOWS_HOST = (ip: string, gw: string): string[] => [
  `netsh interface ip set address "Ethernet 0" static ${ip} 255.255.255.0 ${gw}`,
];

// ──────────────────────────────────────────────────────────────────────────
test.describe.configure({ mode: 'serial' });

test.describe('Secure SMB architecture — UI defect sweep', () => {
  test.beforeAll(async ({ browser }) => {
    mkdirSync('test-results', { recursive: true });
    page = await browser.newPage();
    await waitForApp(page);
  });

  test.afterAll(async () => {
    // Emit the consolidated defect report.
    const bySeverity = (s: Severity) => FINDINGS.filter(f => f.severity === s);
    const summary = {
      generatedAt: new Date().toISOString(),
      totals: {
        ok: bySeverity('ok').length,
        blocker: bySeverity('blocker').length,
        major: bySeverity('major').length,
        minor: bySeverity('minor').length,
      },
      findings: FINDINGS,
    };
    writeFileSync('test-results/smb-defect-report.json', JSON.stringify(summary, null, 2));

    const md: string[] = [
      '# Secure SMB architecture — UI / simulation defect report', '',
      `_Generated ${summary.generatedAt}_`, '',
      `**OK:** ${summary.totals.ok} · **Blockers:** ${summary.totals.blocker} · ` +
      `**Major:** ${summary.totals.major} · **Minor:** ${summary.totals.minor}`, '',
      '| Severity | Area | Check | Expected | Observed |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const f of FINDINGS) {
      if (f.severity === 'ok') continue;
      const esc = (s: string) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      md.push(`| ${f.severity} | ${f.area} | ${esc(f.id)} | ${esc(f.expected)} | ${esc(f.actual)} |`);
    }
    md.push('', '## Passing checks', '');
    for (const f of FINDINGS.filter(x => x.severity === 'ok')) md.push(`- ✅ \`${f.area}\` ${f.id}`);
    writeFileSync('test-results/smb-defect-report.md', md.join('\n'));
    console.log(`\nSMB REPORT → test-results/smb-defect-report.md  (blockers=${summary.totals.blocker} major=${summary.totals.major} minor=${summary.totals.minor})`);
    await page.close();
  });

  // ── 1. Palette completeness ─────────────────────────────────────────────
  test('UI · palette exposes every SMB device class', async () => {
    const required = ['Cisco Switch', 'Huawei Switch', 'Cisco Router', 'Huawei Router', 'Linux PC', 'Windows PC', 'Linux Server', 'Windows Server'];
    for (const label of required) {
      const present = (await page.locator('p', { hasText: new RegExp(`^${label}$`) }).count()) > 0;
      check(`palette has "${label}"`, 'UI', present, `palette lists ${label}`, present ? 'present' : 'MISSING from palette', 'major');
    }
    // Limited devices must be flagged so operators aren't misled.
    const limitedBadges = await page.locator('span', { hasText: /^Limited$/ }).count();
    check('limited devices flagged', 'UI', limitedBadges > 0,
      'firewalls/APs carry a "Limited" badge', limitedBadges > 0 ? `${limitedBadges} badges shown` : 'no Limited badge anywhere', 'minor');
  });

  // ── 2. Real HTML5 drag-and-drop (known first-attempt regression) ────────
  test('UI · first palette drag drops a device on the canvas', async () => {
    const canvas = page.locator('#network-canvas');
    const box = await canvas.boundingBox();
    const before = await page.locator('[data-device-id]').count();
    if (box) {
      await page.evaluate(({ x, y }) => {
        const source = document.querySelector('[draggable="true"]') as HTMLElement;
        const target = document.querySelector('#network-canvas') as HTMLElement;
        const dt = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await page.waitForTimeout(300);
    }
    const after = await page.locator('[data-device-id]').count();
    const ok = after === before + 1;
    check('first-drag places a device', 'UI', ok,
      'one device appears after the first drag', ok ? 'placed on first attempt' : `count ${before} → ${after} (first drag dropped nothing)`, 'major');
    // Clean the canvas so the scripted build starts from zero.
    await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      for (const id of [...st.getState().deviceInstances.keys()]) st.getState().removeDevice(id);
    });
    await page.waitForTimeout(200);
  });

  // ── 3. Build the hardened topology ──────────────────────────────────────
  test('build · place and cable the SMB topology', async () => {
    test.setTimeout(60_000);
    topo = await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      // addDevice swaps in a fresh deviceInstances Map on every call, so we must
      // always read getState() anew rather than caching a snapshot.
      const add = (t: string, x: number, y: number) => st.getState().addDevice(t, x, y).id;
      const ids = {
        rEdge: add('router-cisco', 480, 120),
        rCore: add('router-huawei', 820, 120),
        swUsers: add('switch-cisco', 360, 320),
        swSrv: add('switch-huawei', 940, 320),
        linuxPc: add('linux-pc', 220, 520),
        winPc: add('windows-pc', 440, 520),
        linuxSrv: add('linux-server', 880, 520),
        winSrv: add('windows-server', 1080, 520),
      };
      const ports = (id: string) => {
        const dev = st.getState().deviceInstances.get(id) as Record<string, unknown>;
        return (dev.getPortNames as () => string[])();
      };
      const link = (a: string, ap: string, b: string, bp: string) => st.getState().addConnection(a, ap, b, bp, 'ethernet');
      // Hosts → access switches
      link(ids.linuxPc, ports(ids.linuxPc)[0], ids.swUsers, ports(ids.swUsers)[0]);
      link(ids.winPc,   ports(ids.winPc)[0],   ids.swUsers, ports(ids.swUsers)[1]);
      link(ids.linuxSrv, ports(ids.linuxSrv)[0], ids.swSrv, ports(ids.swSrv)[0]);
      link(ids.winSrv,   ports(ids.winSrv)[0],   ids.swSrv, ports(ids.swSrv)[1]);
      // Switch uplinks → routers (port index 23 == Fa0/24 / Gi0/0/24)
      link(ids.swUsers, ports(ids.swUsers)[23], ids.rEdge, ports(ids.rEdge)[0]);
      link(ids.swSrv,   ports(ids.swSrv)[23],   ids.rCore, ports(ids.rCore)[0]);
      // Inter-router WAN link (router port index 1 == G0/1 / G0/0/1)
      link(ids.rEdge, ports(ids.rEdge)[1], ids.rCore, ports(ids.rCore)[1]);
      return ids;
    }) as Topo;

    const deviceCount = await page.locator('[data-device-id]').count();
    const connCount = await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      return st.getState().connections.length;
    });
    check('8 devices placed', 'build', deviceCount === 8, '8 device nodes on canvas', `${deviceCount} nodes`, 'blocker');
    check('7 cables created', 'build', connCount === 7, '7 ethernet links', `${connCount} links`, 'blocker', topo);
    // Hard gate: if the canvas is empty the rest is meaningless.
    expect(deviceCount, 'topology must build for the sweep to be meaningful').toBeGreaterThan(0);
  });

  // ── 3b. Switch port naming must match real hardware (1-indexed) ─────────
  test('vendor · switch interfaces are numbered like the real hardware', async () => {
    const firstPort = async (id: string) => (await page.evaluate((did) => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const dev = st.getState().deviceInstances.get(did) as Record<string, unknown>;
      return (dev.getPortNames as () => string[])()[0];
    }, id));

    const ciscoFirst = await firstPort(topo.swUsers);
    const ciscoOk = /^FastEthernet0\/1$|^GigabitEthernet0\/1$/.test(ciscoFirst);
    check('Cisco switch first port is …0/1', 'vendor', ciscoOk,
      'Catalyst numbers access ports from 1 (Fa0/1)', `first port = ${ciscoFirst}`, ciscoOk ? 'ok' : 'major');

    const hwFirst = await firstPort(topo.swSrv);
    const hwOk = /0\/0\/1$/.test(hwFirst);
    check('Huawei switch first port is …0/0/1', 'vendor', hwOk,
      'VRP numbers ports from 1 (GigabitEthernet0/0/1)',
      `first port = ${hwFirst}`, hwOk ? 'ok' : 'major');
    // The operator-facing consequence: the Nth physical port and the CLI name
    // disagree, so `interface GigabitEthernet0/0/24` is rejected even though a
    // 24th port exists — surfaced again in the config-acceptance probe.
  });

  // ── 4. Apply the security-hardened configuration to every device ────────
  test('vendor · hardened CLI is accepted by both Cisco and Huawei', async () => {
    test.setTimeout(90_000);

    const blocks: Array<{ id: string; name: string; cmds: string[]; area: Area }> = [
      { id: topo.rEdge, name: 'Cisco R-EDGE', cmds: CISCO_ROUTER('R-EDGE', '10.10.10.1', '172.16.0.1', '172.16.0.2', '10.20.20.0'), area: 'vendor' },
      { id: topo.rCore, name: 'Huawei R-CORE', cmds: HUAWEI_ROUTER('R-CORE', '10.20.20.1', '172.16.0.2', '172.16.0.1', '10.10.10.0'), area: 'vendor' },
      { id: topo.swUsers, name: 'Cisco SW-USERS', cmds: CISCO_SWITCH('SW-USERS'), area: 'vendor' },
      { id: topo.swSrv, name: 'Huawei SW-SRV', cmds: HUAWEI_SWITCH('SW-SRV'), area: 'vendor' },
      { id: topo.linuxPc, name: 'Linux PC', cmds: LINUX_HOST('10.10.10.11', '10.10.10.1'), area: 'vendor' },
      { id: topo.winPc, name: 'Windows PC', cmds: WINDOWS_HOST('10.10.10.12', '10.10.10.1'), area: 'vendor' },
      { id: topo.linuxSrv, name: 'Linux Server', cmds: LINUX_HOST('10.20.20.21', '10.20.20.1'), area: 'vendor' },
      { id: topo.winSrv, name: 'Windows Server', cmds: WINDOWS_HOST('10.20.20.22', '10.20.20.1'), area: 'vendor' },
    ];

    for (const b of blocks) {
      const outs = await applyConfig(b.id, b.cmds);
      const bad = rejectedLines(b.cmds, outs);
      check(`${b.name}: config accepted`, b.area, bad.length === 0,
        'every hardening command accepted', bad.length === 0 ? 'all accepted' : `${bad.length}/${b.cmds.length} rejected`,
        bad.length === 0 ? 'ok' : 'major', bad);
    }
  });

  // ── 5. L2 connectivity actually crosses the cable ───────────────────────
  test('L2 · same-VLAN hosts reach each other through the switch', async () => {
    test.setTimeout(45_000);
    // Linux PC → Windows PC, both on SW-USERS / VLAN10.
    const out = await exec1(topo.linuxPc, 'ping -c 3 10.10.10.12');
    const ok = /3 (packets )?received|0% packet loss|bytes from 10\.10\.10\.12/i.test(out);
    check('intra-VLAN ping (Linux→Windows)', 'L2', ok,
      'ICMP reply across the Cisco switch cable', ok ? 'reply received' : 'no reply / 100% loss',
      ok ? 'ok' : 'major', out.split('\n').slice(-4));

    // Linux Server → Windows Server, both on SW-SRV / VLAN20 (Huawei).
    const out2 = await exec1(topo.linuxSrv, 'ping -c 3 10.20.20.22');
    const ok2 = /received|0% packet loss|bytes from 10\.20\.20\.22/i.test(out2);
    check('intra-VLAN ping (Huawei switch)', 'L2', ok2,
      'ICMP reply across the Huawei switch cable', ok2 ? 'reply received' : 'no reply / 100% loss',
      ok2 ? 'ok' : 'major', out2.split('\n').slice(-4));
  });

  // ── 6. L3 inter-VLAN, cross-vendor routing ──────────────────────────────
  test('L3 · users reach servers across both routers', async () => {
    test.setTimeout(45_000);
    // Step the path: PC → its gateway, gateway → WAN peer, then end-to-end.
    const gw = await exec1(topo.linuxPc, 'ping -c 2 10.10.10.1');
    const gwOk = /received|0% packet loss|bytes from 10\.10\.10\.1/i.test(gw);
    check('host reaches its default gateway', 'L3', gwOk,
      'PC pings the Cisco router LAN IP', gwOk ? 'gateway reachable' : 'gateway unreachable',
      gwOk ? 'ok' : 'major', gw.split('\n').slice(-3));

    const wan = await exec1(topo.rEdge, 'ping 172.16.0.2');
    const wanOk = /Success rate is (100|[1-9]\d) percent|!!!/i.test(wan);
    check('inter-router WAN link up', 'L3', wanOk,
      'Cisco router pings Huawei router over /30', wanOk ? 'WAN peer reachable' : 'WAN peer unreachable',
      wanOk ? 'ok' : 'major', wan.split('\n').slice(-3));

    const e2e = await exec1(topo.linuxPc, 'ping -c 3 10.20.20.21');
    const e2eOk = /received|0% packet loss|bytes from 10\.20\.20\.21/i.test(e2e);
    check('end-to-end user→server routing', 'L3', e2eOk,
      'Linux PC reaches Linux Server across Cisco+Huawei routers',
      e2eOk ? 'end-to-end reachable' : 'no end-to-end path', e2eOk ? 'ok' : 'major', e2e.split('\n').slice(-4));
  });

  // ── 7. Security hardening is reflected in the running configuration ─────
  test('security · hardening is actually present in running-config', async () => {
    test.setTimeout(45_000);
    const ciscoRun = await exec1(topo.rEdge, 'show running-config');

    check('Cisco: SSH transport on VTY', 'security', /transport input ssh/i.test(ciscoRun),
      'vty lines accept SSH only', /transport input ssh/i.test(ciscoRun) ? 'transport input ssh present' : 'VTY transport not restricted to ssh', 'major');
    check('Cisco: no plaintext telnet on VTY', 'security', !/transport input (all|telnet)/i.test(ciscoRun),
      'telnet not permitted inbound', /transport input (all|telnet)/i.test(ciscoRun) ? 'telnet still allowed' : 'telnet not allowed', 'major');
    check('Cisco: enable secret (hashed)', 'security', /enable secret (5|9|\$)/i.test(ciscoRun),
      'enable secret stored hashed', /enable secret/i.test(ciscoRun) ? 'enable secret present' : 'no enable secret', 'major');
    check('Cisco: password encryption service', 'security', /service password-encryption/i.test(ciscoRun),
      'service password-encryption set', /service password-encryption/i.test(ciscoRun) ? 'present' : 'absent', 'minor');
    check('Cisco: ACL bound inbound', 'security', /ip access-group 100 in/i.test(ciscoRun),
      'ACL 100 applied on the LAN interface', /ip access-group 100 in/i.test(ciscoRun) ? 'bound' : 'ACL configured but not bound', 'major');
    // No clear-text user password should ever survive in the running config.
    const plaintext = /password 0 |password S3cure!Pass|secret S3cure!Pass/i.test(ciscoRun);
    check('Cisco: no clear-text credential', 'security', !plaintext,
      'credentials never rendered in clear text', plaintext ? 'CLEAR-TEXT credential found in show run' : 'no clear-text credential', 'blocker');

    // Switch port-security must survive into the config.
    const swRun = await exec1(topo.swUsers, 'show running-config');
    check('Cisco switch: port-security persisted', 'security', /switchport port-security/i.test(swRun),
      'access ports carry port-security', /switchport port-security/i.test(swRun) ? 'present' : 'port-security dropped from config', 'major');

    // Huawei side rendered through its own display command.
    const hwRun = await exec1(topo.rCore, 'display current-configuration');
    check('Huawei: SSH-only VTY (protocol inbound ssh)', 'security', /protocol inbound ssh/i.test(hwRun),
      'VRP vty restricted to ssh', /protocol inbound ssh/i.test(hwRun) ? 'present' : 'not restricted / command lost', 'major', hwRun.split('\n').slice(0, 3));
  });

  // ── 8. Telnet must be refused now that only SSH is allowed ──────────────
  test('security · telnet to a hardened device is refused', async () => {
    test.setTimeout(30_000);
    const out = await exec1(topo.linuxPc, 'telnet 10.10.10.1');
    const refused = /closed|refused|No route|unreachable|Password required|rejected/i.test(out);
    check('telnet refused after hardening', 'security', refused,
      'telnet blocked once transport input ssh is set', refused ? 'connection refused/closed' : 'telnet still connected — hardening not enforced',
      refused ? 'ok' : 'major', out.split('\n').slice(-3));
  });

  // ── 9. Terminal modal lifecycle + powered-off read-only ─────────────────
  test('UI · terminal opens, runs a command, and respects power state', async () => {
    test.setTimeout(40_000);
    const opened = await openTerminal(topo.linuxPc);
    check('terminal opens on double-click', 'UI', opened, 'double-click opens the terminal modal', opened ? 'modal visible' : 'modal never appeared', 'major');
    if (opened) {
      await termType('hostname');
      const txt = await termText();
      const prompted = txt.length > 0;
      check('terminal echoes command output', 'UI', prompted, 'command output rendered', prompted ? 'output present' : 'blank terminal', 'major');
      await closeTerminal();
    }

    // Use a *throwaway* device for the power-off check so the main topology is
    // left fully powered (powering off a real node and forgetting to restore it
    // would poison later probes).
    const throwaway = await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const id = st.getState().addDevice('windows-pc', 250, 700).id;
      const dev = st.getState().deviceInstances.get(id) as Record<string, unknown>;
      (dev.powerOff as () => void)?.();
      (st.getState() as unknown as { syncFromInstances?: () => void }).syncFromInstances?.();
      return id;
    });
    await page.waitForTimeout(300);
    const openedOff = await openTerminal(throwaway);
    if (openedOff) {
      const offBadge = (await page.locator('[data-testid="terminal-modal"]').locator('text=/offline|powered off|read-only/i').count()) > 0;
      check('powered-off terminal flags offline', 'UI', offBadge,
        'an OFFLINE/read-only hint is shown', offBadge ? 'offline hint shown' : 'no offline indication on a powered-off device', 'minor');
      await closeTerminal();
    } else {
      check('powered-off terminal flags offline', 'UI', false,
        'terminal still opens on a powered-off device (read-only)', 'terminal would not open on a powered-off device', 'minor');
    }
    await page.evaluate((id) => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      st.getState().removeDevice(id);
    }, throwaway);
  });

  // ── 10. UI cabling via the Connect button + interface popover ───────────
  test('UI · operator can cable two devices through the Connect flow', async () => {
    test.setTimeout(40_000);
    // Spawn two throwaway hosts and wire them using only DOM affordances.
    const ids = await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      return {
        a: st.getState().addDevice('linux-pc', 300, 660).id,
        b: st.getState().addDevice('linux-pc', 600, 660).id,
      };
    });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      return st.getState().connections.length;
    });

    let cabled = false;
    try {
      await page.locator(`[data-device-id="${ids.a}"]`).first().click();
      await page.locator('button[title="Connect"]').first().click({ timeout: 4000 });
      // Source interface popover → choose the first available interface.
      await page.locator('button', { hasText: /eth0|Ethernet|GigabitEthernet|FastEthernet/i }).first().click({ timeout: 4000 });
      await page.locator(`[data-device-id="${ids.b}"]`).first().click({ timeout: 4000 });
      await page.locator('button', { hasText: /eth0|Ethernet|GigabitEthernet|FastEthernet/i }).first().click({ timeout: 4000 });
      await page.waitForTimeout(400);
      cabled = true;
    } catch {
      cabled = false;
    }
    const after = await page.evaluate(() => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      return st.getState().connections.length;
    });
    const ok = after === before + 1;
    check('UI cabling creates a link', 'UI', ok,
      'Connect → pick interfaces → link appears', ok ? 'link created through the UI' : `connection count unchanged (${before}→${after}); flow ${cabled ? 'completed without adding a link' : 'could not be driven'}`,
      'major');
    // Tidy up the throwaway hosts.
    await page.evaluate(({ a, b }) => {
      const st = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      st.getState().removeDevice(a); st.getState().removeDevice(b);
    }, ids);
  });

  // ── 11. Network logs panel reflects real traffic ────────────────────────
  test('UI · network logs panel surfaces live traffic', async () => {
    test.setTimeout(40_000);
    // Open the logs panel via its toolbar button (title="Logs").
    const toggle = page.locator('button[title="Logs"]').first();
    const hasToggle = (await toggle.count()) > 0;
    if (hasToggle) await toggle.click().catch(() => {});
    await page.waitForTimeout(300);
    const list = page.locator('[data-testid="logs-list"]').first();
    const hasPanel = (await list.count()) > 0;

    // Generate traffic, then look for rendered log rows.
    await exec1(topo.linuxPc, 'ping -c 2 10.10.10.12');
    await page.waitForTimeout(800);
    const rows = hasPanel ? await page.locator('[data-testid="logs-row"]').count() : 0;
    check('logs panel renders traffic', 'UI', hasPanel && rows > 0,
      'ARP/ICMP rows appear after a ping',
      !hasToggle ? 'no "Logs" toolbar button' : !hasPanel ? 'Logs button present but panel never rendered'
        : rows > 0 ? `${rows} log rows` : 'panel present but empty after traffic',
      'minor');
    if (hasToggle) await toggle.click().catch(() => {}); // collapse again
  });

  // ── 12. Windows shell parity ────────────────────────────────────────────
  test('vendor · Windows host terminal answers basic commands', async () => {
    test.setTimeout(30_000);
    const ipcfg = await exec1(topo.winPc, 'ipconfig');
    const ok = /Windows IP Configuration|IPv4 Address|Ethernet adapter/i.test(ipcfg);
    check('Windows ipconfig works', 'vendor', ok,
      'ipconfig prints adapter details', ok ? 'adapter details printed' : 'ipconfig produced nothing useful', 'major', ipcfg.split('\n').slice(0, 3));
    const config = /10\.10\.10\.12/.test(ipcfg);
    check('Windows static IP applied', 'vendor', config,
      'netsh static address took effect', config ? 'IP 10.10.10.12 visible' : 'configured IP not reflected in ipconfig', 'major');
  });
});
