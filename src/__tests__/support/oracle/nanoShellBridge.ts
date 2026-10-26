import { LinuxPC } from '@/network/devices/LinuxPC';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';

const TEMPORARY_FILES = /^\/tmp\/nano\.[^/]+$/;

function listedFiles(pc: LinuxPC, directory: string): string[] {
  const inDirectory = pc.executeShellCommandSync(`find ${directory} -type f`).split('\n').filter((path) => path.startsWith(`${directory}/`));
  const temporary = pc.executeShellCommandSync(`find /tmp -maxdepth 1 -type f -name 'nano.*'`).split('\n').filter((path) => TEMPORARY_FILES.test(path));
  return [...inDirectory, ...temporary];
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function installRealChildShell(fs: InMemoryEditorFsContext, directory = '/tmp'): void {
  const root = `${directory}/`;
  const inScope = (path: string): boolean => path.startsWith(root) || TEMPORARY_FILES.test(path);
  let pc: LinuxPC | null = null;
  let baseline: ReadonlySet<string> = new Set();
  fs.useChildShell((command, stdin, workingDirectory) => {
    if (pc === null) {
      pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
      pc.executeShellCommandSync(`mkdir -p ${directory}`);
      pc.executeShellCommandSync(`cd ${directory}`);
      baseline = new Set(listedFiles(pc, directory));
    }
    const mine = new Set(fs.listPaths().filter(inScope));
    for (const path of listedFiles(pc, directory)) {
      if (!baseline.has(path) && !mine.has(path)) pc.deleteFileFromEditor(path);
    }
    for (const path of mine) {
      pc.executeShellCommandSync(`mkdir -p ${parentOf(path)}`);
      pc.writeFileFromEditor(path, fs.readFile(path) ?? '');
    }
    const stamps = new Map<string, string | null>();
    for (const path of mine) stamps.set(path, pc.editorModificationStamp(path));
    const run = new LinuxEditorFsContext(pc).runChildShell(command, stdin, workingDirectory);
    const present = new Set(listedFiles(pc, directory).filter((path) => !baseline.has(path)));
    for (const path of mine) {
      if (!present.has(path)) fs.deleteFile(path);
    }
    for (const path of present) {
      if (!stamps.has(path) || stamps.get(path) !== pc.editorModificationStamp(path)) fs.writeFile(path, pc.readFileForEditor(path) ?? '');
    }
    return run;
  });
}
