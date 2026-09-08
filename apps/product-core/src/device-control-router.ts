import { randomUUID } from "node:crypto";
import {
  DEVICE_CONTROL_PROTOCOL,
  normalizeDeviceAnnouncement,
  normalizeDeviceResult,
  normalizeDeviceResultChunk,
} from "../../../packages/companion-relay-protocol/src/device-control.js";

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  arch: string;
  appVersion: string;
  capabilities: Array<{ id: string; granted: boolean }>;
  connectedAt: number;
  lastSeenAt: number;
  transport: string;
}

interface DeviceRecord extends DeviceSummary {
  connectionKey: string;
  send: (payload: Record<string, unknown>) => Promise<void>;
}

interface PendingCommand {
  connectionKey: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  chunks?: Array<string | undefined>;
}

export class DeviceControlRouter {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly pending = new Map<string, PendingCommand>();

  register(
    connectionKey: string,
    expectedDeviceId: string,
    transport: string,
    payload: Record<string, unknown>,
    send: (payload: Record<string, unknown>) => Promise<void>,
  ): DeviceSummary {
    const announcement = normalizeDeviceAnnouncement(payload, expectedDeviceId);
    const previous = this.devices.get(connectionKey);
    const now = Date.now();
    const record: DeviceRecord = {
      ...announcement.device,
      capabilities: announcement.capabilities.map((item: { id: string; granted: boolean }) => ({ ...item })),
      connectionKey,
      transport,
      connectedAt: previous?.connectedAt ?? now,
      lastSeenAt: now,
      send,
    };
    this.devices.set(connectionKey, record);
    return this.publicRecord(record);
  }

  unregister(connectionKey: string): void {
    this.devices.delete(connectionKey);
    for (const [requestId, pending] of this.pending) {
      if (pending.connectionKey !== connectionKey) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("设备已离线"));
      this.pending.delete(requestId);
    }
  }

  unregisterTransport(transport: string): void {
    for (const [key, device] of this.devices) if (device.transport === transport) this.unregister(key);
  }

  handleResult(connectionKey: string, payload: Record<string, unknown>): boolean {
    if (payload.type === "device.result.chunk") return this.handleResultChunk(connectionKey, payload);
    let result;
    try { result = normalizeDeviceResult(payload); } catch { return false; }
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.connectionKey !== connectionKey) return false;
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    if (result.ok) pending.resolve(result.output);
    else pending.reject(new Error(result.error));
    return true;
  }

  private handleResultChunk(connectionKey: string, payload: Record<string, unknown>): boolean {
    let chunk;
    try { chunk = normalizeDeviceResultChunk(payload); } catch { return false; }
    const pending = this.pending.get(chunk.requestId);
    if (!pending || pending.connectionKey !== connectionKey) return false;
    if (!pending.chunks) pending.chunks = Array(chunk.total);
    if (pending.chunks.length !== chunk.total) {
      clearTimeout(pending.timer);
      this.pending.delete(chunk.requestId);
      pending.reject(new Error("设备返回了不一致的分片数据"));
      return true;
    }
    pending.chunks[chunk.index] = chunk.data;
    if (pending.chunks.includes(undefined)) return true;
    let value: Record<string, unknown>;
    try { value = JSON.parse(pending.chunks.join("")) as Record<string, unknown>; } catch {
      clearTimeout(pending.timer);
      this.pending.delete(chunk.requestId);
      pending.reject(new Error("设备返回的数据无法解析"));
      return true;
    }
    return this.handleResult(connectionKey, {
      type: "device.result", protocol: DEVICE_CONTROL_PROTOCOL, requestId: chunk.requestId, ...value,
    });
  }

  list(): DeviceSummary[] {
    return [...this.devices.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((record) => this.publicRecord(record));
  }

  resolve(target: string): DeviceSummary {
    const query = target.trim().toLocaleLowerCase();
    const matches = this.list().filter((device) =>
      device.id.toLocaleLowerCase() === query
      || device.id.toLocaleLowerCase().startsWith(query)
      || device.name.toLocaleLowerCase() === query
      || device.name.toLocaleLowerCase().includes(query));
    if (matches.length === 0) throw new Error(`找不到在线设备“${target}”`);
    if (matches.length > 1) throw new Error(`设备“${target}”不唯一，请使用更完整的名称或 ID`);
    return matches[0];
  }

  async execute(target: string, capability: string, input: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    const summary = this.resolve(target);
    const record = [...this.devices.values()].find((item) => item.id === summary.id && item.transport === summary.transport);
    if (!record) throw new Error("设备刚刚离线了");
    const advertised = record.capabilities.find((item) => item.id === capability);
    if (!advertised?.granted) throw new Error(`设备“${record.name}”尚未授权 ${capability}`);
    const requestId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("设备操作超时"));
      }, timeoutMs);
      this.pending.set(requestId, { connectionKey: record.connectionKey, resolve, reject, timer });
    });
    try {
      await record.send({ type: "device.command", protocol: DEVICE_CONTROL_PROTOCOL, requestId, capability, input });
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(requestId);
      throw error;
    }
    return response;
  }

  private publicRecord(record: DeviceRecord): DeviceSummary {
    return {
      id: record.id,
      name: record.name,
      platform: record.platform,
      arch: record.arch,
      appVersion: record.appVersion,
      capabilities: record.capabilities.map((item) => ({ ...item })),
      connectedAt: record.connectedAt,
      lastSeenAt: record.lastSeenAt,
      transport: record.transport,
    };
  }
}
