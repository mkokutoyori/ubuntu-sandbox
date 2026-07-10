import { describe, expect, it } from "vitest";
import { ArgumentParser } from "@/command-kernel/args/argument-parser";
import { CommandDescriptor } from "@/command-kernel/command/types";
import { ShutdownCommand } from "@/command-kernel/commands/shutdown-command";
import { CommandRegistry } from "@/command-kernel/registry/command-registry";
import { UsageError } from "@/command-kernel/errors";
import { DefaultPrivilegePolicy } from "@/command-kernel/session/privilege-policy";
import { Capability, PrivilegeLevel, SimpleUser } from "@/command-kernel/session/types";
import { EchoCommand } from "./_test-commands";

describe("ArgumentParser", () => {
  const parser = new ArgumentParser();
  const descriptor: CommandDescriptor = {
    name: "cp",
    summary: "copie des fichiers",
    usage: "cp [-r] [--verbose] <src> <dst>",
    args: [
      { name: "src", type: "path", required: true, description: "source" },
      { name: "dst", type: "path", required: true, description: "destination" },
    ],
    options: [
      { long: "recursive", short: "r", takesValue: false, description: "récursif" },
      { long: "verbose", takesValue: false, description: "verbeux" },
      { long: "delay", takesValue: true, type: "int", defaultValue: 0, description: "délai" },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };

  it("maps positionals in declaration order", () => {
    const args = parser.parse(["a.txt", "b.txt"], descriptor);
    expect(args.get("src")).toBe("a.txt");
    expect(args.get("dst")).toBe("b.txt");
  });

  it("parses short and long boolean flags", () => {
    const args = parser.parse(["-r", "--verbose", "a.txt", "b.txt"], descriptor);
    expect(args.flag("recursive")).toBe(true);
    expect(args.flag("verbose")).toBe(true);
  });

  it("parses --option=value and coerces the declared type", () => {
    const args = parser.parse(["--delay=5", "a.txt", "b.txt"], descriptor);
    expect(args.get("delay")).toBe(5);
  });

  it("applies default values for absent options", () => {
    const args = parser.parse(["a.txt", "b.txt"], descriptor);
    expect(args.get("delay")).toBe(0);
  });

  it("throws UsageError for a missing required positional", () => {
    expect(() => parser.parse(["a.txt"], descriptor)).toThrow(UsageError);
  });

  it("throws UsageError for an unknown option", () => {
    expect(() => parser.parse(["--bogus", "a.txt", "b.txt"], descriptor)).toThrow(UsageError);
  });

  it("throws UsageError for a variadic required arg left empty", () => {
    const variadicDescriptor: CommandDescriptor = {
      ...descriptor,
      args: [{ name: "files", type: "path", required: true, variadic: true, description: "fichiers" }],
    };
    expect(() => parser.parse([], variadicDescriptor)).toThrow(UsageError);
  });
});

describe("CommandRegistry", () => {
  it("resolves a command by name and by alias", () => {
    const registry = new CommandRegistry();
    registry.register(() => new ShutdownCommand());
    expect(registry.resolve("shutdown")?.descriptor.name).toBe("shutdown");
    expect(registry.resolve("poweroff")?.descriptor.name).toBe("shutdown");
  });

  it("returns a fresh instance on every resolve() call", () => {
    const registry = new CommandRegistry();
    registry.register(() => new EchoCommand());
    const a = registry.resolve("echo");
    const b = registry.resolve("echo");
    expect(a).not.toBe(b);
  });

  it("rejects a duplicate registration unless override is requested", () => {
    const registry = new CommandRegistry();
    registry.register(() => new EchoCommand());
    expect(() => registry.register(() => new EchoCommand())).toThrow();
    expect(() => registry.register(() => new EchoCommand(), { override: true })).not.toThrow();
  });

  it("removes a command and its aliases on unregister", () => {
    const registry = new CommandRegistry();
    registry.register(() => new ShutdownCommand());
    expect(registry.unregister("shutdown")).toBe(true);
    expect(registry.resolve("shutdown")).toBeUndefined();
    expect(registry.resolve("poweroff")).toBeUndefined();
  });

  it("lists descriptors for help generation", () => {
    const registry = new CommandRegistry();
    registry.register(() => new EchoCommand());
    registry.register(() => new ShutdownCommand());
    expect(registry.list().map((d) => d.name).sort()).toEqual(["echo", "shutdown"]);
  });
});

describe("DefaultPrivilegePolicy", () => {
  it("always grants root, regardless of the declared level", () => {
    const policy = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);
    const root = new SimpleUser(0, 0, "root");
    expect(policy.authorize(root).granted).toBe(true);
  });

  it("denies a non-root user for a ROOT-level policy", () => {
    const policy = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);
    const user = new SimpleUser(1000, 1000, "alice");
    const verdict = policy.authorize(user);
    expect(verdict.granted).toBe(false);
    expect(verdict.reason).toMatch(/superutilisateur/);
  });

  it("denies a user missing a required group", () => {
    const policy = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR, ["sudoers"]);
    const user = new SimpleUser(1000, 1000, "alice", new Set(["users"]));
    const verdict = policy.authorize(user);
    expect(verdict.granted).toBe(false);
    expect(verdict.reason).toContain("sudoers");
  });

  it("denies a user missing a required capability", () => {
    const policy = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR, [], [Capability.NET_ADMIN]);
    const user = new SimpleUser(1000, 1000, "alice", new Set(), new Set());
    const verdict = policy.authorize(user);
    expect(verdict.granted).toBe(false);
    expect(verdict.reason).toContain(Capability.NET_ADMIN);
  });

  it("grants a user satisfying every requirement", () => {
    const policy = new DefaultPrivilegePolicy(
      PrivilegeLevel.OPERATOR,
      ["sudoers"],
      [Capability.NET_ADMIN],
    );
    const user = new SimpleUser(1000, 1000, "alice", new Set(["sudoers"]), new Set([Capability.NET_ADMIN]));
    expect(policy.authorize(user).granted).toBe(true);
  });
});
