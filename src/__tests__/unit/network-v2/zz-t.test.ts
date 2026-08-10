import { describe, it } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
describe('t', () => { it('x', async () => {
  const d = new CiscoRouter('R1',0,0); d.powerOn();
  for (const c of ['enable','configure terminal','enable secret level 7 P7!','line console 0','password Motdepasse1','login','exit','service password-encryption','end']) await d.executeCommand(c);
  console.log('A|' + await d.executeCommand('show running-config | include enable'));
  console.log('B|' + await d.executeCommand('show running-config | include enable secret level'));
  console.log('C|' + await d.executeCommand('show running-config | section line console'));
}, 30000); });
