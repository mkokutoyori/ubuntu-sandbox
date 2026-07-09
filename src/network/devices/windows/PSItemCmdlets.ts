import type { WindowsFileSystem, WinDirEntry } from './WindowsFileSystem';
import { PSRegistryProvider, isRegistryPath } from './PSRegistryProvider';
import { parsePSArgs } from './psArgs';
import type { PSDeviceContext } from './PowerShellExecutor';

export interface PSItemContext {
  device: PSDeviceContext;
  cwd: string;
  registry: PSRegistryProvider;
  errorList: string[];
  sessionEnv: Map<string, string>;
  resolveEnvVar: (name: string) => string | undefined;
}

export function handleGetItem(ctx: PSItemContext, args: string[]): string {
    const silentlyContinue = args.some(a => a.toLowerCase() === 'silentlycontinue');
    const target = args.filter(a => !a.startsWith('-') && a.toLowerCase() !== 'silentlycontinue').join(' ');
    if (!target) return "Get-Item : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (isRegistryPath(target)) return ctx.registry.getItem(target);
    const fs = ctx.device.getFileSystem();
    const absPath = fs.normalizePath(target, ctx.cwd);
    const entry = fs.resolve(absPath);
    if (!entry) {
      const errMsg = `Get-Item : Cannot find path '${target}' because it does not exist.`;
      ctx.errorList.unshift(errMsg);
      return silentlyContinue ? '' : errMsg;
    }

    const isDir = entry.type === 'directory';
    const mode = formatPSMode(entry);
    const mtime = formatPSDate(entry.mtime);
    const length = isDir ? '' : String(entry.size);
    const parentDir = absPath.substring(0, absPath.lastIndexOf('\\')) || (absPath + '\\');
    const attrNames = [...entry.attributes].map(a => a.charAt(0).toUpperCase() + a.slice(1));
    if (isDir && !attrNames.includes('Directory')) attrNames.push('Directory');
    if (!isDir && !attrNames.some(a => a.toLowerCase() === 'archive')) attrNames.push('Archive');
    const attrStr = attrNames.join(', ');

    const lines: string[] = [];
    lines.push('');
    lines.push(`    Directory: ${parentDir}`);
    lines.push('');
    lines.push('Mode                 LastWriteTime         Length Name');
    lines.push('----                 -------------         ------ ----');
    lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
    // K:V properties — used by property accessor (Get-Item ...).PropName
    lines.push('');
    lines.push(`FullName      : ${absPath}`);
    lines.push(`Name          : ${entry.name}`);
    lines.push(`Length        : ${length || '0'}`);
    lines.push(`Mode          : ${mode}`);
    lines.push(`Attributes    : ${attrStr}`);
    lines.push(`IsReadOnly    : ${entry.attributes.has('readonly') ? 'True' : 'False'}`);
    lines.push(`LastWriteTime : ${mtime}`);
    lines.push(`PSIsContainer : ${isDir ? 'True' : 'False'}`);
    lines.push('');
    return lines.join('\n');
  }

export function handleGetChildItem(ctx: PSItemContext, args: string[], pipelinePath?: string): string {
    let path = '', filter = '';
    const include: string[] = [], exclude: string[] = [];
    let recurse = false, nameOnly = false, dirOnly = false, fileOnly = false;
    let hidden = false, system = false, force = false, readonly = false;
    let depth: number | undefined;
    let attributes = '';

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-literalpath' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-filter' && args[i + 1]) { filter = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-include' && args[i + 1]) {
        const raw = args[++i].replace(/^["']/,'').replace(/["']$/,'');
        include.push(...raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')));
      }
      else if (a === '-exclude' && args[i + 1]) { exclude.push(...args[++i].replace(/^["']/,'').replace(/["']$/,'').split(',')); }
      else if (a === '-recurse') { recurse = true; }
      else if (a === '-name') { nameOnly = true; }
      else if (a === '-directory') { dirOnly = true; }
      else if (a === '-file') { fileOnly = true; }
      else if (a === '-hidden') { hidden = true; }
      else if (a === '-system') { system = true; }
      else if (a === '-readonly') { readonly = true; }
      else if (a === '-force') { force = true; }
      else if (a === '-depth' && args[i + 1]) { depth = parseInt(args[++i], 10); recurse = true; }
      else if (a === '-attributes' && args[i + 1]) { attributes = args[++i]; }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }

    // Pipeline input path override (from Get-Item piping)
    if (pipelinePath && !path) path = pipelinePath;

    // -Attributes validation
    const validAttrs = new Set(['hidden', 'system', 'archive', 'readonly', 'normal', 'directory', 'encrypted', 'offline', 'reparse', 'sparse', 'temporary']);
    if (attributes) {
      const attrLower = attributes.toLowerCase().replace(/^!/, '');
      if (!validAttrs.has(attrLower)) {
        return `Get-ChildItem : Cannot convert value "${attributes}" to type "System.IO.FileAttributes". Error: "Invalid value for attributes."`;
      }
    }

    // Env: drive
    if (path.toLowerCase() === 'env:' || path.toLowerCase() === 'env:\\') {
      return formatGetChildItemEnv(ctx);
    }

    // Registry path
    if (path && isRegistryPath(path)) return ctx.registry.getChildItem(path);

    const fs = ctx.device.getFileSystem();

    // Handle wildcard in path
    let absPath: string;
    let wildcardFilter = '';
    if (path.includes('*') || path.includes('?')) {
      const lastSep = path.lastIndexOf('\\');
      const dirPart = path.substring(0, lastSep);
      wildcardFilter = path.substring(lastSep + 1);
      absPath = fs.normalizePath(dirPart || '.', ctx.cwd);
      // combine with filter
      if (!filter) filter = wildcardFilter;
    } else {
      absPath = fs.normalizePath(path || '.', ctx.cwd);
    }

    const makeFilterFn = (name: string): boolean => {
      if (filter) {
        const rx = new RegExp('^' + filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        if (!rx.test(name)) return false;
      }
      if (include.length > 0) {
        const match = include.some(p => {
          const clean = p.trim().replace(/^["']|["']$/g, '');
          const rx = new RegExp('^' + clean.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
          return rx.test(name);
        });
        if (!match) return false;
      }
      if (exclude.length > 0) {
        const match = exclude.some(p => {
          const clean = p.trim().replace(/^["']|["']$/g, '');
          const rx = new RegExp('^' + clean.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
          return rx.test(name);
        });
        if (match) return false;
      }
      return true;
    };

    const applyFilter = (entries: WinDirEntry[]) =>
      entries.filter(({ entry }) => {
        if (!makeFilterFn(entry.name)) return false;
        if (dirOnly && entry.type !== 'directory') return false;
        if (fileOnly && entry.type !== 'file') return false;
        // Hidden items filtered by default; -Hidden shows ONLY hidden; -Force shows all
        if (!force && !hidden && entry.attributes.has('hidden')) return false;
        if (hidden && !force && !entry.attributes.has('hidden')) return false;
        // -System shows ONLY system items
        if (system && !force && !entry.attributes.has('system')) return false;
        return true;
      });

    const renderEntries = (filtered: WinDirEntry[], dirPath: string, lines: string[]) => {
      if (filtered.length === 0) return;
      if (nameOnly) {
        for (const { entry } of filtered) lines.push(entry.name);
      } else {
        lines.push('', `    Directory: ${dirPath}`, '', 'Mode                 LastWriteTime         Length Name', '----                 -------------         ------ ----');
        for (const { entry } of filtered) {
          const mode = formatPSMode(entry);
          const mtime = formatPSDate(entry.mtime);
          const length = entry.type === 'file' ? String(entry.size) : '';
          lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
        }
      }
    };

    // Error if path doesn't exist (not a wildcard query)
    const pathEntry = fs.resolve(absPath);
    if (!pathEntry && !wildcardFilter) {
      const displayPath = path || '.';
      return `Get-ChildItem : Cannot find path '${absPath}' because it does not exist.\nAt line:1 char:1\n    + CategoryInfo          : ObjectNotFound: (${displayPath}:String) [Get-ChildItem], ItemNotFoundException`;
    }

    // If path is a file (not a directory), show just the file
    if (pathEntry && pathEntry.type === 'file') {
      const parentPath = absPath.substring(0, absPath.lastIndexOf('\\')) || absPath;
      const fakeEntries: WinDirEntry[] = [{ name: pathEntry.name, entry: pathEntry }];
      const filtered = applyFilter(fakeEntries);
      if (filtered.length === 0) return '';
      const lines: string[] = [];
      renderEntries(filtered, parentPath, lines);
      return lines.join('\n');
    }

    if (recurse) {
      const allDirs = fs.listDirectoryRecursive(absPath);
      const lines: string[] = [];
      const baseDepth = absPath.split('\\').length;
      for (const { path: dirPath, entries } of allDirs) {
        const entryDepth = dirPath.split('\\').length - baseDepth;
        if (depth !== undefined && entryDepth > depth) continue;
        const filtered = applyFilter(entries);
        renderEntries(filtered, dirPath, lines);
      }
      return lines.join('\n');
    }

    const entries = fs.listDirectory(absPath);
    const filtered = applyFilter(entries);
    if (filtered.length === 0) return '';

    const lines: string[] = [];
    renderEntries(filtered, absPath, lines);
    return lines.join('\n');
  }

export function formatGetChildItemEnv(ctx: PSItemContext): string {
    const lines: string[] = ['', 'Name                           Value', '----                           -----'];
    const envVars: Record<string, string> = {
      'Path': ctx.resolveEnvVar('PATH') ?? '',
      'SystemRoot': 'C:\\Windows',
      'TEMP': ctx.resolveEnvVar('TEMP') ?? '',
      'USERNAME': ctx.resolveEnvVar('USERNAME') ?? '',
      'COMPUTERNAME': ctx.resolveEnvVar('COMPUTERNAME') ?? '',
      'OS': 'Windows_NT',
      'PROCESSOR_ARCHITECTURE': 'AMD64',
      'USERPROFILE': ctx.resolveEnvVar('USERPROFILE') ?? '',
      'APPDATA': ctx.resolveEnvVar('APPDATA') ?? '',
      'LOCALAPPDATA': ctx.resolveEnvVar('LOCALAPPDATA') ?? '',
      'PROGRAMFILES': 'C:\\Program Files',
      'WINDIR': 'C:\\Windows',
      'SYSTEMDRIVE': 'C:',
    };
    // Include session overrides
    for (const [k, v] of ctx.sessionEnv.entries()) {
      envVars[k] = v;
    }
    for (const [k, v] of Object.entries(envVars)) {
      lines.push(`${k.padEnd(31)}${v}`);
    }
    return lines.join('\n');
  }

export function handleSetItem(ctx: PSItemContext, args: string[]): string {
    let path = '', value = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && path && !value) { value = args[i].replace(/^["']|["']$/g, ''); }
    }
    // Handle Env: drive: Set-Item -Path Env:VARNAME -Value val
    if (path.toLowerCase().startsWith('env:')) {
      const varName = path.slice(4).replace(/^\\/, '').toUpperCase();
      ctx.sessionEnv.set(varName, value);
    }
    return '';
  }

export function handleRemoveItem(ctx: PSItemContext, args: string[]): string {
    let path = '';
    const recurse = args.some(a => a.toLowerCase() === '-recurse');
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    // Env: drive — drop the variable from session overrides.
    if (path.toLowerCase().startsWith('env:')) {
      const varName = path.slice(4).replace(/^\\/, '').toUpperCase();
      ctx.sessionEnv.delete(varName);
      return '';
    }
    if (isRegistryPath(path)) return ctx.registry.removeItem(path, recurse);
    const fs = ctx.device.getFileSystem();
    const absPath = fs.normalizePath(path, ctx.cwd);
    const entry = fs.resolve(absPath);
    if (!entry) return `Remove-Item : Cannot find path '${path}' because it does not exist.`;
    if (entry.type === 'directory') {
      if (!recurse) {
        return `Remove-Item : ${absPath} is a directory. Use -Recurse to remove the directory and all its contents.`;
      }
      const r = fs.deleteDirectory(absPath);
      return r.ok ? '' : `Remove-Item : ${r.error}`;
    }
    const r = fs.deleteFile(absPath);
    return r.ok ? '' : `Remove-Item : ${r.error}`;
  }

export function handleCopyItem(ctx: PSItemContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    let src = '', dest = '', filter = '', literalPath = '';
    const include: string[] = [], exclude: string[] = [];
    let recurse = false, force = false, passThru = false, container = false, toSession = false, whatIf = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { src = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-literalpath' && args[i + 1]) { literalPath = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-destination' || a === '-dest') && args[i + 1]) { dest = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-filter' && args[i + 1]) { filter = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-include' && args[i + 1]) { include.push(...args[++i].replace(/^["']|["']$/g, '').split(',')); }
      else if (a === '-exclude' && args[i + 1]) { exclude.push(...args[++i].replace(/^["']|["']$/g, '').split(',')); }
      else if (a === '-recurse') { recurse = true; }
      else if (a === '-force') { force = true; }
      else if (a === '-passthru') { passThru = true; }
      else if (a === '-container') { container = true; }
      else if (a === '-whatif') { whatIf = true; }
      else if (a === '-tosession') { toSession = true; i++; } // skip PSSession arg
      else if (a === '-credential') { i++; } // skip credential arg (ignored in sim)
      else if (!args[i].startsWith('-') && !src && !literalPath) { src = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && (src || literalPath) && !dest) { dest = args[i].replace(/^["']|["']$/g, ''); }
    }

    if (toSession) return 'Copy-Item : Remote sessions (ToSession/FromSession) are not supported in this simulator.';

    const effectiveSrcForWhatIf = literalPath || src;
    if (whatIf && effectiveSrcForWhatIf) {
      return `What if: Performing the operation "Copy File" on target "Item: ${effectiveSrcForWhatIf} Destination: ${dest}".`;
    }

    const effectiveSrc = literalPath || src;
    if (!effectiveSrc || !dest) return 'Copy-Item : Source and Destination are required.';

    const absDest = fs.normalizePath(dest, ctx.cwd);
    const destDrive = absDest.substring(0, 2).toUpperCase();
    if (!fs.resolve(destDrive + '\\')) fs.mkdirp(destDrive + '\\');

    // Handle wildcard in source path
    if (effectiveSrc.includes('*') || effectiveSrc.includes('?')) {
      const lastSep = effectiveSrc.lastIndexOf('\\');
      const srcDir = effectiveSrc.substring(0, lastSep);
      const pattern = effectiveSrc.substring(lastSep + 1);
      const absSrcDir = fs.normalizePath(srcDir, ctx.cwd);
      const filterRx = pattern ? new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
      const entries = fs.listDirectory(absSrcDir);
      fs.mkdirp(absDest);
      for (const { entry } of entries) {
        if (filterRx && !filterRx.test(entry.name)) continue;
        if (filter) {
          const filterPattern = filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
          if (!new RegExp('^' + filterPattern + '$', 'i').test(entry.name)) continue;
        }
        if (include.length > 0 && !include.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
        if (exclude.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
        if (entry.type === 'file') {
          fs.copyFile(absSrcDir + '\\' + entry.name, absDest + '\\' + entry.name);
        } else if (entry.type === 'directory' && recurse) {
          copyDirectoryRecursive(fs, absSrcDir + '\\' + entry.name, absDest + '\\' + entry.name, filter, include, exclude);
        }
      }
      if (passThru) {
        const destEntries = fs.listDirectory(absDest);
        if (destEntries.length > 0) return destEntries.map(e => e.entry.name).join('\n');
      }
      return '';
    }

    const absSrc = fs.normalizePath(effectiveSrc, ctx.cwd);
    const srcEntry = fs.resolve(absSrc);
    if (!srcEntry) {
      return `Copy-Item : Cannot find path '${absSrc}' because it does not exist.\nAt line:1 char:1\n    + CategoryInfo          : ObjectNotFound: (${absSrc}:String) [Copy-Item], ItemNotFoundException\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.CopyItemCommand`;
    }

    if (srcEntry.type === 'directory') {
      if (!recurse && !container) {
        return `Copy-Item : The directory '${absSrc}' is not empty. To copy the directory and its contents, use the -Recurse parameter.`;
      }
      if (container && !recurse) {
        // Check if directory has children
        const srcChildren = fs.listDirectory(absSrc);
        if (srcChildren.length > 0) {
          return `Copy-Item : The directory '${absSrc}' contains items. Use -Recurse to copy a directory with contents.`;
        }
        fs.mkdirp(absDest);
        return '';
      }
      // Recursive directory copy
      copyDirectoryRecursive(fs, absSrc, absDest, filter, include, exclude);
      if (passThru) return absDest.substring(absDest.lastIndexOf('\\') + 1);
      return '';
    }

    // File copy
    const destEntry = fs.resolve(absDest);
    if (destEntry && destEntry.type === 'file' && !force) {
      return `Copy-Item : The file '${absDest}' already exists. Use the Force parameter to overwrite it.\nAt line:1 char:1\n    + CategoryInfo          : WriteError: (${absDest}:String) [Copy-Item], IOException`;
    }

    const r = fs.copyFile(absSrc, absDest);
    if (!r.ok) return `Copy-Item : ${r.error}`;

    if (passThru) {
      const destName = absDest.substring(absDest.lastIndexOf('\\') + 1);
      return `Name : ${destName}\nFullName : ${absDest}`;
    }
    return '';
  }

export function handleMoveItem(ctx: PSItemContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    let src = '', dest = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { src = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-destination' || a === '-dest') && args[i + 1]) { dest = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !src) { src = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && src && !dest) { dest = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!src || !dest) return 'Move-Item : Source and Destination are required.';
    const absSrc = fs.normalizePath(src, ctx.cwd);
    const absDest = fs.normalizePath(dest, ctx.cwd);
    const r = fs.moveFile(absSrc, absDest);
    return r.ok ? '' : `Move-Item : ${r.error}`;
  }

export function handleRenameItem(ctx: PSItemContext, args: string[]): string {
    const fs = ctx.device.getFileSystem();
    let path = '', newName = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if ((a === '-path' || a === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-newname' && args[i + 1]) { newName = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && path && !newName) { newName = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path || !newName) return 'Rename-Item : -Path and -NewName are required.';
    const absPath = fs.normalizePath(path, ctx.cwd);
    const parentDir = absPath.substring(0, absPath.lastIndexOf('\\'));
    const absDest = parentDir + '\\' + newName;
    const r = fs.moveFile(absPath, absDest);
    return r.ok ? '' : `Rename-Item : ${r.error}`;
  }

export function copyDirectoryRecursive(fs: WindowsFileSystem, srcPath: string, destPath: string, filter: string, include: string[], exclude: string[]): void {
    fs.mkdirp(destPath);
    const entries = fs.listDirectory(srcPath);
    for (const { entry } of entries) {
      if (filter) {
        const filterPattern = filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
        if (!new RegExp('^' + filterPattern + '$', 'i').test(entry.name)) continue;
      }
      if (include.length > 0 && !include.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
      if (exclude.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
      const srcChild = srcPath + '\\' + entry.name;
      const destChild = destPath + '\\' + entry.name;
      if (entry.type === 'file') {
        fs.copyFile(srcChild, destChild);
      } else {
        copyDirectoryRecursive(fs, srcChild, destChild, filter, include, exclude);
      }
    }
  }

export function formatPSMode(entry: { type: string; attributes: Set<string> }): string {
    const d = entry.type === 'directory' ? 'd' : '-';
    const a = entry.attributes.has('archive') ? 'a' : '-';
    const r = entry.attributes.has('readonly') ? 'r' : '-';
    const h = entry.attributes.has('hidden') ? 'h' : '-';
    const s = entry.attributes.has('system') ? 's' : '-';
    const l = '-'; // reparse point / link
    return d + a + r + h + s + l;
  }

export function formatPSDate(date: Date): string {
    const m = String(date.getMonth() + 1).padStart(2, ' ');
    const d = String(date.getDate()).padStart(2, ' ');
    const y = date.getFullYear();
    let h = date.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${m}/${d}/${y}  ${String(h).padStart(2)}:${min} ${ampm}`;
  }
