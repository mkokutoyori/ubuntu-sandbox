import { PRINTERS, SORT_ITEMS, compareForSort, type PrintContext } from './PsColumns';
import { wantThisProc } from './PsSelect';
import type { PsState } from './PsState';
import type { ProcessTask } from '../../../process/ProcessTask';
import {
  OUTBUF_SIZE, SIGNAL_NAME_WIDTH, SPACE_AMOUNT, TF_LOOSE_TASKS, TF_SHOW_BOTH, TF_SHOW_PROC, TF_SHOW_TASK, PsExit, type FormatNode,
} from './PsTypes';

export function checkArgumentConflicts(state: PsState): void {
  const quick = state.selectionList.filter((node) => node.typecode === 'PID_QUICK').length;
  const fail = (message: string): never => {
    state.output.err(`${message}\n`);
    throw new PsExit(1);
  };
  if (quick > 1) fail('q/-q/--quick-pid can only be used once.');
  if (quick > 0 && state.selectionList.length > quick) fail('q/-q/--quick-pid cannot be combined with other selection options.');
  if (quick > 0 && state.forestType !== '') fail('q/-q/--quick-pid cannot be used together with forest type listings.');
  if (quick > 0 && state.sortList.length > 0) fail('q/-q,--quick-pid cannot be used together with sort options.');
  if (quick > 0 && state.negateSelection) fail('q/-q/--quick-pid cannot be used together with negation switches.');
}

export class PsDisplay {
  private activeCols = 0;
  private didStuff = false;
  private procFormats: FormatNode[] = [];
  private taskFormats: FormatNode[] = [];
  private processes: ProcessTask[] = [];
  private forestChars: string[] = [];
  private readonly context: PrintContext;

  constructor(private readonly state: PsState) {
    const host = state.host;
    this.context = { state, host, maxRightward: 0, wideSignals: false, bootTics: Math.floor(host.uptimeSeconds * host.hertz) };
  }

  private get host() { return this.state.host; }

  private checkHeaderWidth(): void {
    const state = this.state;
    let total = 0;
    let wasNormal = 0;
    let signals = 0;
    const nodes = state.formatList;
    nodes.forEach((node, index) => {
      const hasNext = index < nodes.length - 1;
      switch (node.justify) {
        case 'SIGNAL':
          signals++;
          if (state.signalNames) {
            if (node.width < SIGNAL_NAME_WIDTH) node.width = SIGNAL_NAME_WIDTH;
            node.justify = 'UNLIMITED';
            total += hasNext ? node.width : 3;
          } else {
            total += node.width;
          }
          total += wasNormal;
          wasNormal = 1;
          break;
        case 'UNLIMITED':
          total += hasNext ? node.width : 3;
          total += wasNormal;
          wasNormal = 1;
          break;
        case 'AIX':
          total += node.width;
          wasNormal = 0;
          break;
        default:
          total += node.width;
          total += wasNormal;
          wasNormal = 1;
          break;
      }
    });
    let multiple = 0;
    for (;;) {
      multiple++;
      this.activeCols = state.screenCols * multiple;
      if (this.activeCols >= total) break;
      if (state.screenCols * multiple >= OUTBUF_SIZE / 2) break;
    }
    this.context.wideSignals = total + signals * 7 <= this.activeCols;
  }

  private checkHeaders(): void {
    const state = this.state;
    if (state.headerType === 'multi') {
      state.headerGap = state.screenRows - 1;
      return;
    }
    if (state.headerType === 'none') {
      state.linesToNextHeader = -1;
      return;
    }
    let normal = 0;
    for (const node of state.formatList) {
      if (node.name === '') continue;
      if (node.printer !== null) normal++;
    }
    if (normal === 0) state.linesToNextHeader = -1;
  }

  private listsAndNeeds(): void {
    const state = this.state;
    this.checkHeaders();
    if (state.threadFlags & TF_SHOW_BOTH) {
      this.procFormats = state.formatList.map((node) => ({ ...node, printer: node.print === 'TO' ? 'nop' : node.printer }));
      this.taskFormats = state.formatList.map((node) => ({ ...node, printer: node.print === 'PO' ? 'nop' : node.printer }));
    } else {
      this.procFormats = state.formatList;
      this.taskFormats = state.formatList;
    }
  }

  private emit(task: ProcessTask | null, formats: readonly FormatNode[]): void {
    const state = this.state;
    const context = this.context;
    let correct = 0;
    let actual = 0;
    let dospace = 0;
    let line = '';
    for (let index = 0; index < formats.length; index++) {
      const node = formats[index];
      const last = index === formats.length - 1;
      let tmpspace: number;
      let legit = 0;
      if (!last) {
        context.maxRightward = node.width;
        tmpspace = 0;
      } else {
        tmpspace = correct - actual;
        if (tmpspace < 1) {
          tmpspace = dospace;
          context.maxRightward = this.activeCols - actual - tmpspace;
        } else {
          context.maxRightward = this.activeCols - (correct > actual ? correct : actual);
        }
      }
      if (context.maxRightward <= 0) context.maxRightward = 0;
      else if (context.maxRightward >= OUTBUF_SIZE) context.maxRightward = OUTBUF_SIZE - 1;
      let text = task !== null && node.printer !== null ? PRINTERS[node.printer](context, task) : node.name;
      let amount = text.length;
      if (amount >= OUTBUF_SIZE) {
        text = text.slice(0, OUTBUF_SIZE - 1);
        amount = OUTBUF_SIZE - 1;
      }
      let leftpad = 0;
      switch (node.justify) {
        case 'AIX':
        case 'LEFT':
          leftpad = 0;
          break;
        case 'RIGHT':
          leftpad = Math.max(0, node.width - amount);
          break;
        case 'SIGNAL':
          if (context.wideSignals) {
            leftpad = 16 - amount;
            legit = 7;
          } else {
            leftpad = 9 - amount;
          }
          if (leftpad < 0) leftpad = 0;
          break;
        case 'USER':
          leftpad = Math.max(0, node.width - amount);
          if (!state.userIsNumber) leftpad = 0;
          break;
        case 'WCHAN':
          if (state.wchanIsNumber) {
            leftpad = Math.max(0, node.width - amount);
          } else {
            if (this.activeCols - actual - tmpspace < 1) text = text.slice(0, 1);
            leftpad = 0;
          }
          break;
        case 'UNLIMITED':
          if (this.activeCols - actual - tmpspace < 1) text = text.slice(0, 1);
          leftpad = 0;
          break;
      }
      let space = correct - actual + leftpad;
      if (space < 1) space = dospace;
      if (space > SPACE_AMOUNT) space = SPACE_AMOUNT;
      line += ' '.repeat(space) + text;
      if (last) break;
      actual += space + amount;
      correct += node.width;
      correct += legit;
      if (node.printer !== null && formats[index + 1].printer !== null) {
        correct++;
        dospace = 1;
      } else {
        dospace = 0;
      }
    }
    state.output.out(`${line}\n`);
  }

  private showHeader(formats: readonly FormatNode[]): void {
    this.didStuff = true;
    this.emit(null, formats);
  }

  private showTask(task: ProcessTask, formats: readonly FormatNode[]): void {
    const state = this.state;
    if (--state.linesToNextHeader === 0) {
      state.linesToNextHeader = state.headerGap;
      this.showHeader(formats);
    }
    this.didStuff = true;
    this.emit(task, formats);
  }

  private showFinal(formats: readonly FormatNode[]): void {
    const state = this.state;
    if (this.didStuff) return;
    if (--state.linesToNextHeader === 0) {
      state.linesToNextHeader = state.headerGap;
      this.showHeader(formats);
    }
    throw new PsExit(1);
  }

  private simpleSpew(): void {
    const state = this.state;
    const threadsToo = (state.threadFlags & (TF_LOOSE_TASKS | TF_SHOW_TASK)) !== 0;
    let reaped: readonly ProcessTask[];
    const head = state.selectionList[0];
    if (head !== undefined && head.typecode === 'PID_QUICK') {
      const pids = [...head.values].reverse() as number[];
      reaped = this.host.selected(pids, threadsToo);
    } else {
      reaped = this.host.tasks(threadsToo);
    }
    switch (state.threadFlags & (TF_SHOW_PROC | TF_LOOSE_TASKS | TF_SHOW_TASK)) {
      case TF_SHOW_PROC:
        for (const task of reaped) if (wantThisProc(state, task)) this.showTask(task, this.procFormats);
        break;
      case TF_SHOW_TASK:
      case TF_SHOW_PROC | TF_LOOSE_TASKS:
        for (const task of reaped) if (wantThisProc(state, task)) this.showTask(task, this.taskFormats);
        break;
      case TF_SHOW_PROC | TF_SHOW_TASK: {
        const sorted = [...reaped].sort((a, b) => a.ticsBegan - b.ticsBegan).sort((a, b) => a.tgid - b.tgid);
        let index = 0;
        while (index < sorted.length) {
          const leader = sorted[index];
          if (wantThisProc(state, leader)) {
            const self = leader.tid;
            this.showTask(leader, this.procFormats);
            let moved = false;
            for (; index < sorted.length; index++) {
              if (sorted[index].tgid !== self) {
                moved = true;
                break;
              }
              this.showTask(sorted[index], this.taskFormats);
            }
            if (moved) continue;
            break;
          }
          index++;
        }
        break;
      }
    }
  }

  private prepForestSort(): void {
    const state = this.state;
    if (state.sortList.length === 0) state.sortList = [{ sort: 'ID_PPID', order: 1 }];
    state.sortList = [{ sort: 'TICS_BEGAN', order: 1 }, ...state.sortList];
  }

  private setPrefixLength(level: number): void {
    this.state.forestPrefix = this.forestChars.slice(0, level).join('');
  }

  private showTree(self: number, count: number, level: number, haveSibling: boolean): void {
    const processes = this.processes;
    if (level > 0) this.forestChars[level - 1] = haveSibling ? '+' : 'L';
    this.setPrefixLength(level);
    this.showTask(processes[self], this.state.formatList);
    let index = 0;
    for (;;) {
      if (index >= count) return;
      if (processes[index].ppid === processes[self].tid) break;
      index++;
    }
    if (level > 0) this.forestChars[level - 1] = haveSibling ? '|' : ' ';
    this.setPrefixLength(level);
    for (;;) {
      const selfPid = processes[self].tid;
      let moreChildren = true;
      if (index >= count) break;
      if (index + 1 >= count) moreChildren = false;
      else if (processes[index + 1].ppid !== selfPid) moreChildren = false;
      if (selfPid === 1 && this.state.forestType !== 'u') this.showTree(index++, count, level, moreChildren);
      else this.showTree(index++, count, level + 1, moreChildren);
      if (!moreChildren) break;
    }
    this.setPrefixLength(level);
  }

  private showForest(count: number): void {
    const processes = this.processes;
    for (let i = count - 1; i >= 0; i--) {
      let rooted = true;
      for (let j = count - 1; j >= 0; j--) {
        if (processes[j].tid === processes[i].ppid) {
          rooted = false;
          break;
        }
      }
      if (rooted) this.showTree(i, count, 0, false);
    }
  }

  private fancySpew(): void {
    const state = this.state;
    const reaped = this.host.tasks((state.threadFlags & TF_LOOSE_TASKS) !== 0);
    this.processes = reaped.filter((task) => wantThisProc(state, task));
    if (this.processes.length === 0) return;
    if (state.forestType !== '') this.prepForestSort();
    const sortContext = { hertz: this.host.hertz, bootTics: this.context.bootTics };
    for (const node of state.sortList) {
      const item = SORT_ITEMS[node.sort];
      this.processes = [...this.processes].sort((a, b) => compareForSort(
        item.kind, item.value(a, sortContext), item.value(b, sortContext), node.order, (x, y) => this.host.collate(x, y),
      ));
    }
    if (state.forestType !== '') this.showForest(this.processes.length);
    else for (const task of this.processes) this.showTask(task, this.procFormats);
  }

  run(): void {
    const state = this.state;
    this.checkHeaderWidth();
    this.listsAndNeeds();
    if (state.forestType !== '' || state.sortList.length > 0) this.fancySpew();
    else this.simpleSpew();
    this.showFinal(state.formatList);
  }
}

