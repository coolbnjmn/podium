export class TTLCache<T> {
  private value: T | undefined;
  private expiresAt = 0;

  constructor(private readonly ttlMs: number) {}

  async getOrLoad(loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.value !== undefined && now < this.expiresAt) {
      return this.value;
    }
    const loaded = await loader();
    this.value = loaded;
    this.expiresAt = now + this.ttlMs;
    return loaded;
  }

  invalidate(): void {
    this.value = undefined;
    this.expiresAt = 0;
  }
}
