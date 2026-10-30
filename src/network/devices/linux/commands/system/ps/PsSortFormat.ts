import { AIX_ARRAY, MACRO_ARRAY, SHORTSORT_ARRAY, searchFormatArray } from './PsFormatTable';
import type { PsState } from './PsState';
import {
  FF_Bj, FF_Bl, FF_Bs, FF_Bu, FF_Bv, FF_Fc, FF_LX, FF_Lm, FF_Uf, FF_Uj, FF_Ul, FM_F, FM_M, FM_P, FM_c, FM_j, FM_y,
  PER_IRIX_l, PER_SANE_USER, PER_ZAP_ADDR, TF_MUST_USE, TF_NO_SORT, TF_U_L, TF_U_T,
  type DeferredOption, type FormatNode, type SortNode, type SortSource,
} from './PsTypes';

const FORMAT_SEPARATORS = /[ ,\t\n]/;

function doOneSpec(state: PsState, spec: string, override: string | null): FormatNode[] | null {
  const found = searchFormatArray(spec);
  if (found !== undefined) {
    let width: number;
    if (found.pidMax) {
      width = state.host.pidDigits;
      if (found.head.length > width) width = found.head.length;
    } else {
      width = found.width;
    }
    const node: FormatNode = {
      name: override ?? found.head,
      printer: found.printer,
      width: override === null ? width : Math.max(width, override.length),
      vendor: found.vendor,
      justify: found.justify,
      print: found.print,
      pidMax: found.pidMax,
    };
    return [node];
  }
  const macro = MACRO_ARRAY.get(spec);
  if (macro === undefined) return null;
  const list: FormatNode[] = [];
  let walk = macro;
  while (walk !== '') {
    const distance = walk.search(/[, ]/) < 0 ? walk.length : walk.search(/[, ]/);
    const expanded = doOneSpec(state, walk.slice(0, distance), override);
    if (expanded === null) return null;
    list.unshift(...expanded);
    walk = walk.slice(distance);
    if (walk !== '') walk = walk.slice(1);
  }
  return list;
}

function oWrap(state: PsState, deferred: DeferredOption, kind: 'b' | 'u'): void {
  const pid = doOneSpec(state, 'pid', null) as FormatNode[];
  deferred.formats = [...deferred.formats, ...pid];
  const trailer = doOneSpec(state, kind === 'b' ? 'END_BSD' : 'END_SYS5', null) as FormatNode[];
  deferred.formats = [...trailer, ...deferred.formats];
}

function aixFormatParse(state: PsState, text: string, deferred: { formats: FormatNode[] }): string | null {
  let items = 0;
  let index = 0;
  const next = (): string => text[index++] ?? '\0';
  let c = next();
  let phase: 'initial' | 'more' | 'desc' = 'initial';
  for (;;) {
    if (phase === 'initial') {
      if (c === '%') {
        phase = 'desc';
        continue;
      }
      if (c === '\0') break;
      items++;
      phase = 'more';
    } else if (phase === 'more') {
      c = next();
      if (c === '%') {
        phase = 'desc';
        continue;
      }
      if (c === ' ') continue;
      if (c !== '\0') return 'improper AIX field descriptor';
      break;
    } else {
      items++;
      c = next();
      if (c !== '\0' && c !== ' ') {
        phase = 'initial';
        continue;
      }
      return 'missing AIX field descriptor';
    }
  }
  let walk = 0;
  while (items-- > 0) {
    let node: FormatNode[] | null;
    if (text[walk] === '%') {
      walk++;
      if (text[walk] === '%') return 'missing AIX field descriptor';
      const aix = AIX_ARRAY.get(text[walk] ?? '');
      walk++;
      if (aix === undefined) return 'unknown AIX field descriptor';
      node = doOneSpec(state, aix.spec, aix.head);
      if (node === null) return 'AIX field descriptor processing bug';
    } else {
      const length = text.indexOf('%', walk) < 0 ? text.length - walk : text.indexOf('%', walk) - walk;
      const literal = text.slice(walk, walk + length);
      walk += length;
      node = [{ name: literal, printer: null, width: length, vendor: 'AIX', justify: 'AIX', print: 'ET', pidMax: false }];
    }
    deferred.formats = [...node, ...deferred.formats];
  }
  state.alreadyParsedFormat = true;
  return null;
}

let formatErrorText = '';

function formatParse(state: PsState, text: string, deferred: { formats: FormatNode[] }): string | null {
  let error: string | null;
  const attempt = (): string | null => {
    let needItem = true;
    let items = 0;
    for (let index = 0; index < Math.max(text.length, 1); index++) {
      const ch = text[index] ?? '\0';
      if (ch === ' ' || ch === ',' || ch === '\t' || ch === '\n' || ch === '\0') {
        if (needItem) return 'improper format list';
        needItem = true;
      } else {
        if (needItem) items++;
        needItem = false;
      }
    }
    if (items === 0) return 'empty format list';
    let buffer = text;
    if (needItem) buffer = buffer.slice(0, -1);
    let walk = buffer;
    while (items-- > 0) {
      const separator = walk.search(FORMAT_SEPARATORS);
      let item = walk;
      let rest: string | null = null;
      if (separator >= 0) {
        rest = walk.slice(separator + 1);
        if (items > 0) item = walk.slice(0, separator);
      }
      let override: string | null = null;
      const equal = item.indexOf('=');
      if (equal >= 0) {
        override = item.slice(equal + 1);
        item = item.slice(0, equal);
      }
      let width: number | null = null;
      const colon = item.indexOf(':');
      if (colon >= 0) {
        const digits = item.slice(colon + 1);
        item = item.slice(0, colon);
        if (!/^[0-9]+$/.test(digits) || digits.startsWith('0') || digits === '' || parseInt(digits, 10) <= 0) {
          return 'column widths must be unsigned decimal numbers';
        }
        width = parseInt(digits, 10);
      }
      const node = doOneSpec(state, item, override);
      if (node === null) {
        if (formatErrorText === '') formatErrorText = `unknown user-defined format specifier "${item}"`.slice(0, 79);
        return formatErrorText;
      }
      if (width !== null) {
        if (node.length > 1) return 'can not set width for a macro (multi-column) format specifier';
        node[0].width = width;
      }
      deferred.formats = [...node, ...deferred.formats];
      walk = separator >= 0 && items > 0 ? (rest ?? '') : '';
    }
    return null;
  };
  error = attempt();
  if (error === null) {
    state.alreadyParsedFormat = true;
    return null;
  }
  if (text.includes('%')) error = aixFormatParse(state, text, deferred);
  return error;
}

function doOneSortSpec(spec: string): SortNode | null {
  let descending = false;
  let name = spec;
  if (name.startsWith('-')) {
    descending = true;
    name = name.slice(1);
  } else if (name.startsWith('+')) {
    name = name.slice(1);
  }
  const found = searchFormatArray(name);
  return found === undefined ? null : { sort: found.sort, order: descending ? -1 : 1 };
}

function longSortParse(text: string, deferred: DeferredOption): string | null {
  let needItem = true;
  let items = 0;
  for (let index = 0; index < Math.max(text.length, 1); index++) {
    const ch = text[index] ?? '\0';
    if (ch === ' ' || ch === ',' || ch === '\t' || ch === '\n' || ch === '\0') {
      if (needItem) return 'improper sort list';
      needItem = true;
    } else {
      if (needItem) items++;
      needItem = false;
    }
  }
  if (items === 0) return 'empty sort list';
  let walk = needItem ? text.slice(0, -1) : text;
  while (items-- > 0) {
    const separator = walk.search(FORMAT_SEPARATORS);
    const item = separator < 0 ? walk : walk.slice(0, separator);
    const node = doOneSortSpec(item);
    if (node === null) return 'unknown sort specifier';
    deferred.sorts = [node, ...deferred.sorts];
    walk = separator < 0 ? '' : walk.slice(separator + 1);
  }
  return null;
}

const SHORT_SORT_CODES = 'CGJKMNPRSTUcfgjkmnoprstuvy+-';

function verifyShortSort(state: PsState, text: string): string | null {
  for (const ch of text) if (!SHORT_SORT_CODES.includes(ch)) return 'bad sorting code';
  const seen = new Set<string>();
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === '+' || ch === '-') {
      const following = text[index + 1];
      if (following === undefined || following === '+' || following === '-') return 'bad sorting code';
      continue;
    }
    if (ch === 'P' && state.forestType !== '') return 'PPID sort and forest output conflict';
    if (seen.has(ch)) return 'bad sorting code';
    seen.add(ch);
  }
  return null;
}

function shortSortParse(text: string, deferred: DeferredOption): string | null {
  let order = 1;
  for (const ch of text) {
    if (ch === '+') {
      order = 1;
    } else if (ch === '-') {
      order = -1;
    } else {
      const spec = SHORTSORT_ARRAY.get(ch);
      if (spec === undefined) return 'unknown sort specifier';
      const node = doOneSortSpec(spec);
      if (node === null) return 'unknown sort specifier';
      node.order = order;
      deferred.sorts = [node, ...deferred.sorts];
      order = 0;
    }
  }
  return null;
}

function parseOption(state: PsState, deferred: DeferredOption): string | null {
  let error: string | null;
  switch (deferred.source) {
    case 'B_o':
    case 'G_format':
    case 'U_o':
      error = formatParse(state, deferred.text, deferred);
      if (error === null) state.alreadyParsedFormat = true;
      return error;
    case 'U_O':
      if (state.alreadyParsedFormat) return 'option -O can not follow other format options';
      error = formatParse(state, deferred.text, deferred);
      if (error !== null) return error;
      state.alreadyParsedFormat = true;
      oWrap(state, deferred, 'u');
      return null;
    case 'B_O':
      error = state.haveGnuSort || state.alreadyParsedSort ? 'multiple sort options' : verifyShortSort(state, deferred.text);
      if (error === null) {
        shortSortParse(deferred.text, deferred);
        state.alreadyParsedSort = true;
        return null;
      }
      if (state.alreadyParsedFormat) return 'option O is neither first format nor sort order';
      if (formatParse(state, deferred.text, deferred) === null) {
        state.alreadyParsedFormat = true;
        oWrap(state, deferred, 'b');
        return null;
      }
      return error;
    case 'G_sort':
    case 'B_m':
      error = state.alreadyParsedSort ? 'multiple sort options' : longSortParse(deferred.text, deferred);
      state.alreadyParsedSort = true;
      return error;
  }
}

export function deferSfOption(state: PsState, text: string, source: SortSource): void {
  state.deferred.unshift({ source, text, formats: [], sorts: [] });
  if (source === 'G_sort') state.haveGnuSort = true;
}

function addAfter(list: FormatNode[], findMe: string, node: FormatNode): boolean {
  const index = list.findIndex((candidate) => candidate.name === findMe);
  if (index < 0) return false;
  list.splice(index + 1, 0, node);
  return true;
}

function deleteNamed(list: FormatNode[], findMe: string): boolean {
  const index = list.findIndex((candidate) => candidate.name === findMe);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

function single(state: PsState, spec: string): FormatNode {
  return (doOneSpec(state, spec, null) as FormatNode[])[0];
}

function generateSysvList(state: PsState): string | null {
  const list: FormatNode[] = [];
  const push = (spec: string): void => { list.unshift(...(doOneSpec(state, spec, null) as FormatNode[])); };
  const flags = state.formatFlags;
  const modifiers = state.formatModifiers;
  if ((modifiers & FM_y) && !(flags & FF_Ul)) return 'modifier -y without format -l makes no sense';
  if (state.preferBsdDefaults) {
    push(flags ? 'cmd' : 'args');
    push('bsdtime');
    if (!(flags & FF_Ul)) push('stat');
  } else {
    push(flags & FF_Uf ? 'cmd' : 'ucmd');
    push('time');
  }
  push('tname');
  if (flags & FF_Uf) push('stime');
  if (modifiers & FM_F) {
    if (!(modifiers & FM_P)) push('psr');
    if (!((flags & FF_Ul) && (modifiers & FM_y))) push('rss');
  }
  if (flags & FF_Ul) push('wchan');
  if ((flags & FF_Ul) && !(modifiers & FM_y)) {
    if (state.personality & PER_IRIX_l) {
      push('sgi_rss');
      list.unshift({ name: ':', printer: null, width: 1, vendor: 'AIX', justify: 'AIX', print: 'ET', pidMax: false });
    }
  }
  if ((modifiers & FM_F) || (flags & FF_Ul)) push('sz');
  if (flags & FF_Ul) {
    if (modifiers & FM_y) push('rss');
    else if (state.personality & (PER_ZAP_ADDR | PER_IRIX_l)) push('sgi_p');
    else push('addr_1');
  }
  if (modifiers & FM_c) {
    push('pri');
    push('class');
  } else if (flags & FF_Ul) {
    push('ni');
    if (state.personality & PER_IRIX_l) push('priority');
    else push('opri');
  }
  if ((state.threadFlags & TF_U_L) && (flags & FF_Uf)) push('nlwp');
  if ((flags & (FF_Uf | FF_Ul)) && !(modifiers & FM_c)) push('c');
  if (modifiers & FM_P) push('psr');
  if (state.threadFlags & TF_U_L) push('lwp');
  if (modifiers & FM_j) {
    push('sid');
    push('pgid');
  }
  if (flags & (FF_Uf | FF_Ul)) push('ppid');
  if (state.threadFlags & TF_U_T) push('spid');
  push('pid');
  if (flags & FF_Uf) {
    if (state.personality & PER_SANE_USER) push('user');
    else push('uid_hack');
  } else if (flags & FF_Ul) {
    push('uid');
  }
  if (flags & FF_Ul) {
    push('s');
    if (!(modifiers & FM_y)) push('f');
  }
  if (modifiers & FM_M) push('label');
  state.formatList = list;
  return null;
}

export function processSfOptions(state: PsState): string | null {
  const ordered = [...state.deferred].reverse();
  for (const deferred of ordered) {
    const error = parseOption(state, deferred);
    if (error !== null) return error;
  }
  state.formatList = [];
  for (const deferred of state.deferred) {
    for (const node of deferred.formats) state.formatList.unshift(node);
    deferred.formats = [];
  }
  for (const deferred of state.deferred) {
    if (deferred.sorts.length > 0) state.sortList = [...deferred.sorts, ...state.sortList];
    deferred.sorts = [];
  }
  if (state.sortList.length > 0 && (state.threadFlags & TF_NO_SORT)) return 'tell <procps@freelists.org> what you expected';
  if (!state.formatFlags && !state.formatModifiers && state.formatList.length === 0) {
    const environment = state.host.environment('PS_FORMAT');
    if (environment !== undefined && environment !== '') {
      if (state.threadFlags & TF_MUST_USE) return 'tell <procps@freelists.org> what you want (-L/-T, -m/m/H, and $PS_FORMAT)';
      const scratch: { formats: FormatNode[] } = { formats: [] };
      const error = formatParse(state, environment, scratch);
      if (error === null) {
        for (const node of scratch.formats) state.formatList.unshift(node);
        return null;
      }
      state.output.err(`warning: $PS_FORMAT ignored. (${error})\n`);
    }
  }
  if (state.formatList.length > 0) {
    if (state.formatFlags) return 'conflicting format options';
    if (state.formatModifiers) return 'can not use output modifiers with user-defined output';
    if (state.threadFlags & TF_MUST_USE) return '-L/-T with H/m/-m and -o/-O/o/O is nonsense';
    return null;
  }
  let spec: string | null;
  switch (state.formatFlags) {
    case 0: spec = null; break;
    case FF_Uf | FF_Ul: spec = state.sysvFlFormat; break;
    case FF_Uf: spec = state.sysvFFormat; break;
    case FF_Ul: spec = state.sysvLFormat; break;
    case FF_Uj: spec = state.sysvJFormat; break;
    case FF_Uj | FF_Ul: spec = 'RD_lj'; break;
    case FF_Uj | FF_Uf: spec = 'RD_fj'; break;
    case FF_Bj: spec = state.bsdJFormat; break;
    case FF_Bl: spec = state.bsdLFormat; break;
    case FF_Bs: spec = state.bsdSFormat; break;
    case FF_Bu: spec = state.bsdUFormat; break;
    case FF_Bv: spec = state.bsdVFormat; break;
    case FF_LX: spec = 'OL_X'; break;
    case FF_Lm: spec = 'OL_m'; break;
    case FF_Fc: spec = 'FLASK_context'; break;
    default: return 'conflicting format options';
  }
  if (spec === null) return generateSysvList(state);
  state.formatList = [];
  for (const node of doOneSpec(state, spec, null) ?? []) state.formatList.unshift(node);
  const list = state.formatList;
  const modifiers = state.formatModifiers;
  if (modifiers & FM_j) {
    if (!addAfter(list, 'PPID', single(state, 'pgid')) && !addAfter(list, 'PID', single(state, 'pgid'))) return 'internal error: no PID or PPID for -j option';
    if (!addAfter(list, 'PGID', single(state, 'sid'))) return 'lost my PGID';
  }
  if (modifiers & FM_y) {
    deleteNamed(list, 'F');
    if (addAfter(list, 'ADDR', single(state, 'rss'))) deleteNamed(list, 'ADDR');
  }
  if (modifiers & FM_c) {
    deleteNamed(list, '%CPU');
    deleteNamed(list, 'CPU');
    deleteNamed(list, 'CP');
    deleteNamed(list, 'C');
    deleteNamed(list, 'NI');
    if (!addAfter(list, 'PRI', single(state, 'class'))) return 'internal error: no PRI for -c option';
    deleteNamed(list, 'PRI');
    if (!addAfter(list, 'CLS', single(state, 'pri'))) return 'lost my CLS';
  }
  if (state.threadFlags & TF_U_T) {
    if (!addAfter(list, 'PID', single(state, 'spid')) && (state.threadFlags & TF_MUST_USE)) return '-T with H/-m/m but no PID for SPID to follow';
  }
  if (state.threadFlags & TF_U_L) {
    const lwp = single(state, 'lwp');
    const placed = ['SID', 'SESS', 'PGID', 'PGRP', 'PPID', 'PID'].some((name) => addAfter(list, name, lwp));
    if (!placed && (state.threadFlags & TF_MUST_USE)) return '-L with H/-m/m but no PID/PGID/SID/SESS for NLWP to follow';
    addAfter(list, '%CPU', single(state, 'nlwp'));
  }
  if (modifiers & FM_M) list.unshift(single(state, 'label'));
  if ((state.personality & PER_ZAP_ADDR) && (state.formatFlags & FF_Ul)) {
    if (addAfter(list, 'ADDR', single(state, 'sgi_p'))) deleteNamed(list, 'ADDR');
  }
  if ((state.personality & PER_SANE_USER) && (state.formatFlags & FF_Uf)) {
    if (addAfter(list, 'UID', single(state, 'user'))) deleteNamed(list, 'UID');
  }
  return null;
}

export function resetFormatErrorText(): void {
  formatErrorText = '';
}
