import { parseRuntimeAnnouncement } from "../../../packages/companion-relay-protocol/src/index.js";

export interface RuntimeNode {
  id: string;
  name: string;
  capabilities: readonly string[];
  connectedAt: number;
}

/**
 * Core-local inventory of remote capability processes. The relay can see an
 * opaque frame only; Core owns the allow-list and its lifetime. Keeping the
 * inventory separate from transport lets the same workers be used after Core
 * moves from Windows to macOS.
 */
export class RuntimeNodeRegistry {
  private readonly nodes = new Map<string, RuntimeNode>();

  register(peerId: string, payload: unknown): RuntimeNode {
    const announcement = parseRuntimeAnnouncement(payload);
    if (announcement.nodeId !== peerId) {
      throw new Error("Runtime node ID must match its authenticated relay peer ID");
    }
    const node: RuntimeNode = Object.freeze({
      id: announcement.nodeId,
      name: announcement.name,
      capabilities: announcement.capabilities,
      connectedAt: Date.now(),
    });
    this.nodes.set(node.id, node);
    return node;
  }

  unregister(peerId: string): void {
    this.nodes.delete(peerId);
  }

  clear(): void {
    this.nodes.clear();
  }

  list(): readonly RuntimeNode[] {
    return [...this.nodes.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  findByCapability(capability: string): RuntimeNode | null {
    return this.list().find((node) => node.capabilities.includes(capability)) ?? null;
  }
}
