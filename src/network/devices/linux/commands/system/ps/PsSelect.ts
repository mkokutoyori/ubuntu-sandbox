import type { PsState } from './PsState';
import type { ProcessTask } from '../../../process/ProcessTask';
import { SS_B_a, SS_B_g, SS_B_x, SS_U_a, SS_U_d, PER_NO_DEFAULT_g } from './PsTypes';

export function selectBitsSetup(state: PsState): string | null {
  if (state.simpleSelect === 0 && !state.preferBsdDefaults) {
    state.selectBits = 0xaa00;
    return null;
  }
  const value = !(state.personality & PER_NO_DEFAULT_g) && !(state.simpleSelect & (SS_U_a | SS_U_d))
    ? state.simpleSelect | SS_B_g
    : state.simpleSelect;
  switch (value) {
    case SS_U_a | SS_U_d: state.selectBits = 0x3f3f; break;
    case SS_U_a: state.selectBits = 0x0303; break;
    case SS_U_d: state.selectBits = 0x3333; break;
    case 0: state.selectBits = 0x0202; break;
    case SS_B_a: state.selectBits = 0x0303; break;
    case SS_B_x: state.selectBits = 0x2222; break;
    case SS_B_x | SS_B_a: state.selectBits = 0x3333; break;
    case SS_B_g: state.selectBits = 0x0a0a; break;
    case SS_B_g | SS_B_a: state.selectBits = 0x0f0f; break;
    case SS_B_g | SS_B_x: state.selectBits = 0xaaaa; break;
    case SS_B_g | SS_B_x | SS_B_a:
      state.allProcesses = true;
      state.simpleSelect = 0;
      break;
    default:
      return 'process selection options conflict';
  }
  return null;
}

function tableAccept(state: PsState, task: ProcessTask): boolean {
  const index = (task.euid === state.cachedEuid ? 1 : 0)
    | (task.session === task.tgid ? 2 : 0)
    | (task.tty === 0 ? 4 : 0)
    | (task.tty === state.cachedTty ? 8 : 0);
  return (state.selectBits & (1 << index)) !== 0;
}

function commandMatches(task: ProcessTask, selected: string): boolean {
  if (task.cmd.length === 15 && selected.length >= 15 && task.cmd.slice(0, 15) === selected.slice(0, 15)) return true;
  return task.cmd === selected.slice(0, 63);
}

function wasListed(state: PsState, task: ProcessTask): boolean {
  for (const node of state.selectionList) {
    for (const value of node.values) {
      switch (node.typecode) {
        case 'RUID': if (task.ruid === value) return true; break;
        case 'EUID': if (task.euid === value) return true; break;
        case 'SUID': if (task.suid === value) return true; break;
        case 'FUID': if (task.fuid === value) return true; break;
        case 'RGID': if (task.rgid === value) return true; break;
        case 'EGID': if (task.egid === value) return true; break;
        case 'SGID': if (task.sgid === value) return true; break;
        case 'FGID': if (task.fgid === value) return true; break;
        case 'PGRP': if (task.pgrp === value) return true; break;
        case 'PID': case 'PID_QUICK': if (task.tgid === value) return true; break;
        case 'PPID': if (task.ppid === value) return true; break;
        case 'TTY': if (task.tty === value) return true; break;
        case 'SESS': if (task.session === value) return true; break;
        case 'COMM': if (typeof value === 'string' && commandMatches(task, value)) return true; break;
      }
    }
  }
  return false;
}

export function wantThisProc(state: PsState, task: ProcessTask): boolean {
  let accepted = true;
  if (!state.allProcesses) {
    if (state.simpleSelect !== 0 || state.selectionList.length === 0) {
      if (tableAccept(state, task)) return finish(state, task, true);
    }
    accepted = wasListed(state, task);
  }
  return finish(state, task, accepted);
}

function finish(state: PsState, task: ProcessTask, accepted: boolean): boolean {
  let result = accepted;
  if (state.runningOnly && !(task.state === 'R' || task.state === 'D')) result = false;
  return state.negateSelection ? !result : result;
}
