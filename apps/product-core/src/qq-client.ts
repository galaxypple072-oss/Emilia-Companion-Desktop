export interface QqClient {
  sendPrivateMessage(qq: string, message: string): Promise<Record<string, unknown>>;
  sendPrivateImage(qq: string, file: string, options?: { summary?: string; subType?: number }): Promise<Record<string, unknown>>;
  sendPrivateFile(qq: string, file: string, name: string): Promise<Record<string, unknown>>;
  getImage(file: string): Promise<{ file?: string; url?: string; file_size?: number; file_name?: string; bytes?: Buffer }>;
}

/** Prefers the encrypted Worker transport while keeping an explicitly local
 * OneBot fallback for an in-place Windows Core during migration. */
export class SplitQqClient implements QqClient {
  private readonly remote: QqClient;
  private readonly local: QqClient;

  constructor(remote: QqClient, local: QqClient) {
    this.remote = remote;
    this.local = local;
  }
  async sendPrivateMessage(qq: string, message: string): Promise<Record<string, unknown>> {
    try { return await this.remote.sendPrivateMessage(qq, message); }
    catch (error) { console.warn(`[qq] remote text transport unavailable; using local OneBot: ${error instanceof Error ? error.message : String(error)}`); return this.local.sendPrivateMessage(qq, message); }
  }
  async sendPrivateImage(qq: string, file: string, options?: { summary?: string; subType?: number }): Promise<Record<string, unknown>> {
    try { return await this.remote.sendPrivateImage(qq, file, options); }
    catch (error) { console.warn(`[qq] remote image transport unavailable; using local OneBot: ${error instanceof Error ? error.message : String(error)}`); return this.local.sendPrivateImage(qq, file, options); }
  }
  async sendPrivateFile(qq: string, file: string, name: string): Promise<Record<string, unknown>> {
    try { return await this.remote.sendPrivateFile(qq, file, name); }
    catch (error) { console.warn(`[qq] remote file transport unavailable; using local OneBot: ${error instanceof Error ? error.message : String(error)}`); return this.local.sendPrivateFile(qq, file, name); }
  }
  async getImage(file: string): Promise<{ file?: string; url?: string; file_size?: number; file_name?: string; bytes?: Buffer }> {
    try { return await this.remote.getImage(file); }
    catch (error) { console.warn(`[qq] remote image lookup unavailable; using local OneBot: ${error instanceof Error ? error.message : String(error)}`); return this.local.getImage(file); }
  }
}
