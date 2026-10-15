import { describe, expect, it } from "vitest";
import { ArgumentTypeRegistry, InterfaceIdType } from "../src/argument-types.js";
import { CliEngine } from "../src/engine.js";
import { PrivilegeLevel, UserIdentity, type CommandDefinition } from "../src/types.js";

interface Device {
    interfaces: Array<{ name: string; ip?: string }>;
}

function setup(privilege = PrivilegeLevel.SUPERUSER) {
    const device: Device = { interfaces: [{ name: "eth0" }] };
    const argumentTypes = ArgumentTypeRegistry.withBuiltIns().register(
        "interface-id",
        new InterfaceIdType(context => (context.device as Device).interfaces.map(iface => iface.name))
    );
    const modes = [
        { id: "operational", prompt: (session: import("../src/types.js").CliSession) => `${session.hostname}> ` },
        { id: "configure", parentId: "operational", prompt: (session: import("../src/types.js").CliSession) => `${session.hostname}(config)# ` }
    ];
    const commands: CommandDefinition<Device>[] = [
        {
            id: "show.interface",
            mode: "operational",
            syntax: "show interface <interfaceId>",
            description: "Show interface",
            arguments: [{ name: "interfaceId", type: "interface-id" }],
            handler: ({ device: target, args }) => {
                const iface = target.interfaces.find(item => item.name === args.interfaceId);
                return iface ? { status: "success" as const, data: iface } :
                    { status: "error" as const, code: "NOT_FOUND", message: "Not found" };
            }
        },
        {
            id: "configure",
            mode: "operational",
            syntax: "configure",
            description: "Configure",
            privilege: PrivilegeLevel.CONFIG_ADMIN,
            handler: () => ({ status: "mode-change" as const, modeId: "configure" })
        },
        {
            id: "set.ip",
            mode: "configure",
            syntax: "set interface <interfaceId> ip <address>",
            description: "Set IP",
            privilege: PrivilegeLevel.CONFIG_ADMIN,
            arguments: [{ name: "interfaceId", type: "interface-id" }, { name: "address", type: "ipv4" }],
            handler: ({ device: target, args }) => {
                const iface = target.interfaces.find(item => item.name === args.interfaceId);
                if (!iface) return { status: "error" as const, code: "NOT_FOUND", message: "Not found" };
                iface.ip = String(args.address);
                return { status: "success" as const, message: "updated" };
            }
        }
    ];
    return new CliEngine({ device, hostname: "R1", user: new UserIdentity("tester", privilege), modes, commands, argumentTypes });
}

describe("CliEngine", () => {
    it("executes a command with a validated argument", async () => {
        const engine = setup();
        const result = await engine.execute("show interface eth0");
        expect(result.status).toBe("success");
    });

    it("rejects invalid IPv4 values", async () => {
        const engine = setup();
        await engine.execute("configure");
        const result = await engine.execute("set interface eth0 ip 999.1.1.1");
        expect(result.status).toBe("error");
    });

    it("enforces privileges", async () => {
        const engine = setup(PrivilegeLevel.VIEWER);
        const result = await engine.execute("configure");
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.code).toBe("PERMISSION_DENIED");
    });

    it("rejects extra arguments", async () => {
        const engine = setup();
        const result = await engine.execute("show interface eth0 extra");
        expect(result.status).toBe("error");
    });

    it("changes modes explicitly", async () => {
        const engine = setup();
        await engine.execute("configure");
        expect(engine.session.currentModeId).toBe("configure");
    });
});
