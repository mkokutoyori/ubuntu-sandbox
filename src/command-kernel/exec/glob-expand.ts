import { FileSystemActor, MachineApi } from "../machine/types";

const GLOB_METACHARS = /[*?[]/;

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else if (c === "[") {
      let cls = "[";
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        cls += pattern[i];
        i++;
      }
      cls += "]";
      re += cls;
    } else if ("\\^$.|+()".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}

export async function expandGlob(
  word: string,
  cwd: string,
  machine: MachineApi,
  actor: FileSystemActor,
): Promise<string[]> {
  if (!GLOB_METACHARS.test(word)) return [word];

  const slash = word.lastIndexOf("/");
  const dirToken = slash >= 0 ? word.slice(0, slash) || "/" : ".";
  const pattern = slash >= 0 ? word.slice(slash + 1) : word;

  let entries;
  try {
    entries = await machine.fs.list(machine.fs.resolve(cwd, dirToken), actor);
  } catch {
    return [word];
  }

  const regex = globToRegExp(pattern);
  const matches = entries
    .map((e) => e.path.split("/").pop() ?? e.path)
    .filter((name) => (pattern.startsWith(".") || !name.startsWith(".")) && regex.test(name))
    .sort();

  if (matches.length === 0) return [word];
  const prefix = slash >= 0 ? `${dirToken}/` : "";
  return matches.map((name) => `${prefix}${name}`);
}
