import { UsageError } from "../errors";
import { CommandDescriptor } from "../command/types";
import { ArgType, OptionSpec } from "./types";
import { ParsedArgs } from "./parsed-args";

export class ArgumentParser {
  parse(argv: readonly string[], descriptor: CommandDescriptor): ParsedArgs {
    const options = new Map<string, unknown>();
    const positionalValues: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      const shorthand = /^-\d+$/.test(token) ? descriptor.options.find((s) => s.numericShorthand) : undefined;
      const cluster = this.expandShortCluster(token, descriptor.options);
      const glued = this.matchGluedShortValue(token, descriptor.options);
      if (shorthand) {
        options.set(shorthand.long, this.coerce(token.slice(1), shorthand.type ?? "int"));
      } else if (cluster) {
        for (const spec of cluster) options.set(spec.long, true);
      } else if (glued) {
        options.set(glued.spec.long, this.coerce(glued.value, glued.spec.type ?? "string"));
      } else if (token.startsWith("-") && token !== "-" && token !== "--") {
        const spec = this.findOption(token, descriptor.options);
        if (!spec) {
          if (descriptor.lenientOptions) {
            positionalValues.push(token);
            continue;
          }
          throw new UsageError(`option inconnue : ${token}`);
        }
        if (spec.takesValue) {
          const inline = token.includes("=") ? token.split("=").slice(1).join("=") : argv[++i];
          if (inline === undefined) {
            throw new UsageError(`valeur manquante pour ${token}`);
          }
          options.set(spec.long, this.coerce(inline, spec.type ?? "string"));
        } else {
          options.set(spec.long, true);
        }
      } else if (token === "--") {
        positionalValues.push(...argv.slice(i + 1));
        break;
      } else {
        positionalValues.push(token);
      }
    }

    for (const spec of descriptor.options) {
      if (!options.has(spec.long) && spec.defaultValue !== undefined) {
        options.set(spec.long, spec.defaultValue);
      }
    }

    const positionals = new Map<string, unknown>();
    let cursor = 0;
    for (const spec of descriptor.args) {
      if (spec.variadic) {
        const values = positionalValues.slice(cursor);
        if (spec.required && values.length === 0) {
          throw new UsageError(
            `argument requis manquant : <${spec.name}...>\nusage : ${descriptor.usage}`,
          );
        }
        if (values.length > 0) {
          positionals.set(spec.name, values.map((v) => this.coerce(v, spec.type)));
        }
        cursor = positionalValues.length;
        break;
      }
      const raw = positionalValues[cursor++];
      if (raw === undefined) {
        if (spec.required) {
          throw new UsageError(
            `argument requis manquant : <${spec.name}>\nusage : ${descriptor.usage}`,
          );
        }
        continue;
      }
      positionals.set(spec.name, this.coerce(raw, spec.type));
    }

    return new ParsedArgs(positionals, options, positionalValues.slice(cursor));
  }

  private expandShortCluster(
    token: string,
    specs: readonly OptionSpec[],
  ): OptionSpec[] | undefined {
    if (!/^-[a-zA-Z]{2,}$/.test(token)) return undefined;
    const letters = token.slice(1).split("");
    const resolved: OptionSpec[] = [];
    for (const letter of letters) {
      const spec = specs.find((s) => s.short === letter && !s.takesValue);
      if (!spec) return undefined;
      resolved.push(spec);
    }
    return resolved;
  }

  private matchGluedShortValue(
    token: string,
    specs: readonly OptionSpec[],
  ): { spec: OptionSpec; value: string } | undefined {
    if (!token.startsWith("-") || token.startsWith("--")) return undefined;
    if (token.includes("=") || token.length < 3) return undefined;
    const spec = specs.find((s) => s.short === token[1] && s.takesValue);
    if (!spec) return undefined;
    return { spec, value: token.slice(2) };
  }

  private findOption(
    token: string,
    specs: readonly OptionSpec[],
  ): OptionSpec | undefined {
    const clean = token.replace(/^-+/, "").split("=")[0];
    return specs.find((s) => s.long === clean || s.short === clean);
  }

  private coerce(raw: string, type: ArgType): unknown {
    switch (type) {
      case "int": {
        const n = Number.parseInt(raw, 10);
        if (Number.isNaN(n)) throw new UsageError(`entier attendu : "${raw}"`);
        return n;
      }
      case "float": {
        const f = Number.parseFloat(raw);
        if (Number.isNaN(f)) throw new UsageError(`nombre attendu : "${raw}"`);
        return f;
      }
      case "boolean":
        return raw === "true" || raw === "1" || raw === "yes";
      default:
        return raw;
    }
  }
}
