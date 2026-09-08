export interface CompanionEndpoint {
  run(signal: AbortSignal): Promise<void>;
  broadcast(event: Record<string, unknown>): void;
}

export class CompositeCompanionEndpoint implements CompanionEndpoint {
  private readonly endpoints: CompanionEndpoint[];

  constructor(endpoints: CompanionEndpoint[]) {
    this.endpoints = endpoints;
  }

  run(signal: AbortSignal): Promise<void> {
    return Promise.all(this.endpoints.map((endpoint) => endpoint.run(signal))).then(() => undefined);
  }

  broadcast(event: Record<string, unknown>): void {
    for (const endpoint of this.endpoints) endpoint.broadcast(event);
  }
}
