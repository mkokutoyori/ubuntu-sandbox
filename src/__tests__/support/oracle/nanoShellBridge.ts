import { LinuxPC } from '@/network/devices/LinuxPC';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';

function listedFiles(pc: LinuxPC, directory: string): string[] {
  return pc.executeShellCommandSync(`find ${directory} -type f`).split('\n').filter((path) => path.startsWith(`${directory}/`));
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function installRealChildShell(fs: InMemoryEditorFsContext, directory = '/tmp'): void {
  const root = `${directory}/`;
  let pc: LinuxPC | null = null;
  let baseline: ReadonlySet<string> = new Set();
  fs.useChildShell((command, stdin, workingDirectory) => {
    if (pc === null) {
      pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
      pc.executeShellCommandSync(`mkdir -p ${directory}`);
      pc.executeShellCommandSync(`cd ${directory}`);
      baseline = new Set(listedFiles(pc, directory));
    }
    for (const path of fs.listPaths()) {
      if (!path.startsWith(root)) continue;
      pc.executeShellCommandSync(`mkdir -p ${parentOf(path)}`);
      pc.writeFileFromEditor(path, fs.readFile(path) ?? '');
    }
    const run = new LinuxEditorFsContext(pc).runChildShell(command, stdin, workingDirectory);
    const present = new Set(listedFiles(pc, directory).filter((path) => !baseline.has(path)));
    for (const path of fs.listPaths()) {
      if (path.startsWith(root) && !present.has(path)) fs.deleteFile(path);
    }
    for (const path of present) fs.writeFile(path, pc.readFileForEditor(path) ?? '');
    return run;
  });
}
