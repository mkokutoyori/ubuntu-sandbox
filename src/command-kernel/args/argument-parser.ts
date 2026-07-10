import { UsageError } from "../errors";
import { CommandDescriptor } from "../command/types";
import { ArgType, OptionSpec } from "./types";
import { ParsedArgs } from "./parsed-args";

/**
 * Convertit un argv brut ["-n", "5", "/etc/hosts"] en ParsedArgs typés,
 * en s'appuyant sur les specs déclarées par le CommandDescriptor.
 * Lève UsageError si l'entrée ne respecte pas le contrat.
 */
export class ArgumentParser {
  parse(argv: readonly string[], descriptor: CommandDescriptor): ParsedArgs {
    const options = new Map<string, unknown>();
    const positionalValues: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token.startsWith("-") && token !== "-" && token !== "--") {
        const spec = this.findOption(token, descriptor.options);
        if (!spec) throw new UsageError(`option inconnue : ${token}`);
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

    // Valeurs par défaut des options absentes
    for (const spec of descriptor.options) {
      if (!options.has(spec.long) && spec.defaultValue !== undefined) {
        options.set(spec.long, spec.defaultValue);
      }
    }

    // Mapping des positionnels sur leurs specs
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
        positionals.set(spec.name, values.map((v) => this.coerce(v, spec.type)));
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
        return raw; // string & path (la résolution du path se fait via fs.resolve)
    }
  }
}
