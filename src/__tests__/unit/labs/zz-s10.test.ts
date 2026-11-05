import { it } from 'vitest';
import { buildMeridian } from '@/labs/entrepriseMeridian/build';
const run = async (d: any, ...c: string[]) => { const o: string[] = []; for (const x of c) o.push(await d.executeCommand(x)); return o.join('\n'); };
it('x', async () => {
  const { devices } = await buildMeridian();
  const hq = devices.get('FGT-HQ')!, vis = devices.get('PC-VISITEUR')!, pc = devices.get('PC-AGENCE1')!;
  console.log(await run(hq, 'config firewall policy', 'edit 10', 'set logtraffic all', 'next', 'end', 'config log memory setting', 'set status enable', 'end', 'config log memory filter', 'set traffic enable', 'end'));
  console.log('--sniff start', await run(hq, 'diagnose sniffer packet wan1 "esp or port 500" 4 6'));
  await run(pc, 'ping -c 2 10.0.0.50');
  await run(vis, 'curl -s http://203.0.113.10/');
  console.log('--log', await run(hq, 'execute log filter category 0', 'execute log display'));
  console.log('--session', await run(hq, 'diagnose sys session filter dport 80', 'diagnose sys session list'));
  console.log('--tunnel stats', await run(hq, 'get vpn ipsec tunnel summary', 'get vpn ipsec stats crypto'));
  console.log('--down then ping', await run(hq, 'diagnose vpn tunnel down to-ag1'), await run(pc, 'ping -c 2 10.0.0.50'));
  console.log('--after', await run(pc, 'ping -c 3 10.0.0.50'));
});
