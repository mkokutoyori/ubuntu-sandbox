/**
 * Huawei VRP CLI basics — mode navigation, sysname, display family,
 * context help (?), abbreviations, undo, history, save/quit.
 *
 * 66 steps. Not assertions — a transcript dump for gap analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpHuawei, resetSim, type HuaweiStepInput } from './_huawei-suite';

describe('debug-dump: huawei-cli-basics', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();

    const steps: HuaweiStepInput[] = [
      { section: 'user view / version / clock', cmd: 'display version' },
      'display clock',
      'display device',
      'display users',
      'display history-command',
      'display cpu-usage',
      'display memory-usage',
      'display saved-configuration',
      'display startup',

      { section: 'mode navigation', cmd: 'system-view' },
      'sysname SW-CORE',
      'display this',
      'header shell information "Authorized access only"',
      'interface GigabitEthernet0/0/1',
      'display this',
      'quit',
      'vlan 10',
      'quit',
      'user-interface console 0',
      'quit',
      'aaa',
      'quit',
      'return',
      'display current-configuration',

      { section: 'abbreviations (Huawei allows unambiguous prefixes)', cmd: 'sys' },
      'sysn SW-EDGE',
      'dis cu',
      'q',
      'ret',
      'disp version',
      'dis clock',

      { section: 'context help (?)', cmd: 'display ?' },
      '?',
      'system-view',
      'interface ?',
      'vlan ?',
      'stp ?',
      'undo ?',
      'return',

      { section: 'undo / negation', cmd: 'system-view' },
      'sysname TEMP',
      'undo sysname',
      'info-center enable',
      'undo info-center enable',
      'interface GigabitEthernet0/0/5',
      'description test-port',
      'undo description',
      'shutdown',
      'undo shutdown',
      'quit',
      'return',

      { section: 'display filtering / paging', cmd: 'display current-configuration | include vlan' },
      'display current-configuration | begin interface',
      'display interface brief | exclude down',
      'screen-length 0 temporary',
      'display version | include VRP',

      { section: 'diagnostics', cmd: 'display diagnostic-information' },
      'display alarm',
      'display logbuffer',
      'display trapbuffer',
      'display elabel',
      'display patch-information',
      'display license',

      { section: 'save / reboot lifecycle', cmd: 'save' },
      'save force',
      'system-view',
      'commit',
      'return',
      'reset saved-configuration',
      'reboot',
    ];

    await dumpHuawei(
      'huawei-cli-basics',
      topology,
      steps,
      'focus=VRP user/system-view navigation, help, abbreviations, undo',
    );
  });
});
