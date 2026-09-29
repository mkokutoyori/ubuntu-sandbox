export function noopSshLocalFs() {
  return {
    readFile: () => null,
    writeFile: () => undefined,
    chmod: () => true,
    resolveInode: () => null,
    mkdirp: () => undefined,
  };
}
