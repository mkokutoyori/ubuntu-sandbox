/**
 * Profil CPU (CDP) d'une epreuve du laboratoire nat-lab : `PROFILE=curl-ext-500 npx playwright test e2e/nat-lab-profil-cpu.spec.ts` ecrit le temps propre par
 * fonction dans /tmp/claude-0/profile-<epreuve>.txt et le profil complet (.cpuprofile) a cote. Sans PROFILE, le cas est ignore.
 */
import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { buildLab, lineCount, openTerminal, typeIn, waitForStore } from './helpers/natLab';

const SCENARIO = process.env.PROFILE ?? 'curl-ext-500';
const COMMANDS: Record<string, { client: 'lin' | 'ext' | 'srv'; target: string; command: (t: string) => string; tcpdump: boolean }> = {
  'curl-ext-500': { client: 'lin', target: '203.0.113.9', command: (t) => `for i in $(seq 1 500); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`, tcpdump: false },
  'curl-2000': { client: 'lin', target: '170.20.0.2', command: (t) => `for i in $(seq 1 2000); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`, tcpdump: true },
  'srv-ping-f-router': { client: 'srv', target: '192.168.10.1', command: (t) => `ping -f -c 1000 ${t}; echo FINISHED`, tcpdump: true },
  'curl-500': { client: 'lin', target: '170.20.0.2', command: (t) => `for i in $(seq 1 500); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`, tcpdump: true },
};

test('profile', async ({ page }) => {
  test.skip(!process.env.PROFILE, 'PROFILE=<epreuve> pour profiler');
  test.setTimeout(600_000);
  const spec = COMMANDS[SCENARIO];
  await page.goto('/');
  await waitForStore(page);
  const ids = await buildLab(page);
  await openTerminal(page, ids.r);
  await typeIn(page, ids.r, 'enable');
  if (spec.tcpdump) {
    await typeIn(page, ids.r, 'debug ip nat');
    await openTerminal(page, ids.web2);
    await typeIn(page, ids.web2, 'sudo tcpdump -i eth0 -n');
  }
  await openTerminal(page, ids[spec.client]);
  await page.waitForTimeout(1500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await typeIn(page, ids[spec.client], spec.command(spec.target)).catch(() => undefined);
  for (let i = 0; i < 500; i++) {
    await page.waitForTimeout(1000);
    if (await lineCount(page, ids[spec.client], 'FINISHED') > 0) break;
  }
  const { profile } = await cdp.send('Profiler.stop');
  type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
  const nodes = new Map<number, Node>((profile.nodes as Node[]).map((n) => [n.id, n]));
  const self = new Map<string, number>();
  const samples = profile.samples as number[];
  const deltas = profile.timeDeltas as number[];
  for (let i = 0; i < samples.length; i++) {
    const n = nodes.get(samples[i]) as Node;
    const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/src\//, 'src/').slice(0, 90)}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + deltas[i] / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${v.toFixed(0).padStart(7)}ms ${k}`);
  writeFileSync(`/tmp/claude-0/profile-${SCENARIO}.txt`, `total ${total.toFixed(0)}ms\n${top.join('\n')}\n`);
  writeFileSync(`/tmp/claude-0/profile-${SCENARIO}.cpuprofile`, JSON.stringify(profile));
});
