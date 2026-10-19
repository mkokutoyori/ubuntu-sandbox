import { LinuxPC } from '@/network/devices/LinuxPC';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';

const TMP = '/tmp/';

function listedFiles(pc: LinuxPC): string[] {
  return pc.executeShellCommandSync('ls -A1 /tmp').split('\n').filter((name) => name !== '' && pc.editorPathKind(`${TMP}${name}`) === 'file');
}

export function installRealChildShell(fs: InMemoryEditorFsContext): void {
  let pc: LinuxPC | null = null;
  let baseline: ReadonlySet<string> = new Set();
  fs.useChildShell((command, stdin) => {
    if (pc === null) {
      pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
      pc.executeShellCommandSync('cd /tmp');
      baseline = new Set(listedFiles(pc));
    }
    for (const path of fs.listPaths()) {
      if (path.startsWith(TMP)) pc.writeFileFromEditor(path, fs.readFile(path) ?? '');
    }
    const run = new LinuxEditorFsContext(pc).runChildShell(command, stdin);
    const present = new Set(listedFiles(pc).filter((name) => !baseline.has(name)));
    for (const path of fs.listPaths()) {
      if (path.startsWith(TMP) && !present.has(path.slice(TMP.length))) fs.deleteFile(path);
    }
    for (const name of present) fs.writeFile(`${TMP}${name}`, pc.readFileForEditor(`${TMP}${name}`) ?? '');
    return run;
  });
}
