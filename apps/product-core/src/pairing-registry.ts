import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ProductStore } from "./store.ts";

const STATE_KEY = "companion.pairing.v1";
const DEFAULT_INVITATION_TTL_MS = 10 * 60_000;
const MAX_INVITATIONS = 12;
const MAX_DEVICES = 80;

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface StoredDevice extends PairedDevice { tokenHash: string }
interface Invitation { id: string; tokenHash: string; expiresAt: number; createdAt: number }
interface PairingState { version: 1; invitations: Invitation[]; devices: StoredDevice[] }

function hash(token: string): string {
  return createHash("sha256").update(`emilia-pairing-device-v1:${token}`).digest("base64url");
}

function publicDevice(device: StoredDevice): PairedDevice {
  return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt };
}

function cleanName(value: unknown): string {
  const name = String(value ?? "").replace(/[^\p{L}\p{N}_. -]/gu, "").trim().slice(0, 60);
  return name || "新设备";
}

function emptyState(): PairingState { return { version: 1, invitations: [], devices: [] }; }

/**
 * Stores only SHA-256 hashes of invitation and device tokens in Core's SQLite
 * state. An invitation can be redeemed exactly once; the client then receives
 * a separate durable token which the host can revoke independently.
 */
export class PairingRegistry {
  private readonly store: ProductStore;
  private readonly now: () => number;

  constructor(store: ProductStore, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  createInvitation(ttlMs = DEFAULT_INVITATION_TTL_MS): { token: string; expiresAt: number } {
    const now = this.now();
    const state = this.load(now);
    const token = randomBytes(32).toString("base64url");
    state.invitations.push({ id: randomUUID(), tokenHash: hash(token), createdAt: now, expiresAt: now + Math.max(60_000, Math.min(30 * 60_000, ttlMs)) });
    state.invitations = state.invitations.slice(-MAX_INVITATIONS);
    this.save(state, now);
    return { token, expiresAt: state.invitations.at(-1)!.expiresAt };
  }

  authenticate(token: string, name: unknown): { replacementToken: string | null; device: PairedDevice } | null {
    const now = this.now();
    const state = this.load(now);
    const tokenHash = hash(token);
    const existing = state.devices.find((device) => device.tokenHash === tokenHash);
    if (existing) {
      existing.lastSeenAt = now;
      existing.name = cleanName(name);
      this.save(state, now);
      return { replacementToken: null, device: publicDevice(existing) };
    }
    const invitationIndex = state.invitations.findIndex((invitation) => invitation.tokenHash === tokenHash);
    if (invitationIndex < 0) return null;
    state.invitations.splice(invitationIndex, 1);
    const replacementToken = randomBytes(32).toString("base64url");
    const device: StoredDevice = { id: randomUUID(), name: cleanName(name), tokenHash: hash(replacementToken), createdAt: now, lastSeenAt: now };
    state.devices.push(device);
    state.devices = state.devices.slice(-MAX_DEVICES);
    this.save(state, now);
    return { replacementToken, device: publicDevice(device) };
  }

  listDevices(): PairedDevice[] {
    return this.load(this.now()).devices.map(publicDevice).sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  revokeDevice(id: string): boolean {
    const now = this.now();
    const state = this.load(now);
    const before = state.devices.length;
    state.devices = state.devices.filter((device) => device.id !== id);
    if (state.devices.length === before) return false;
    this.save(state, now);
    return true;
  }

  private load(now: number): PairingState {
    let state = emptyState();
    const raw = this.store.getState(STATE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<PairingState>;
        if (parsed.version === 1 && Array.isArray(parsed.invitations) && Array.isArray(parsed.devices)) {
          state = {
            version: 1,
            invitations: parsed.invitations.filter((item): item is Invitation => Boolean(item && typeof item.id === "string" && typeof item.tokenHash === "string" && Number.isFinite(item.expiresAt) && Number.isFinite(item.createdAt))),
            devices: parsed.devices.filter((item): item is StoredDevice => Boolean(item && typeof item.id === "string" && typeof item.tokenHash === "string" && typeof item.name === "string" && Number.isFinite(item.createdAt) && Number.isFinite(item.lastSeenAt))),
          };
        }
      } catch { /* malformed local state is replaced with an empty registry */ }
    }
    const active = state.invitations.filter((item) => item.expiresAt > now);
    if (active.length !== state.invitations.length) {
      state.invitations = active;
      this.save(state, now);
    }
    return state;
  }

  private save(state: PairingState, now: number): void {
    this.store.setState(STATE_KEY, JSON.stringify(state), now);
  }
}
