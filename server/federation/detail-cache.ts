/** A bounded, expiring LRU. Only the latest authorized response is kept per detail view. */
export class DetailCache<T> {
  private entries = new Map<string, { value: T; expires: number; bytes: number }>();
  private bytes = 0;
  constructor(
    private now = Date.now,
    private maxBytes = 4 * 1024 * 1024,
    private maxEntries = 16,
    private ttl = 60000,
  ) {}
  get size() {
    return this.entries.size;
  }
  get byteSize() {
    return this.bytes;
  }
  private remove(key: string) {
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(key);
    }
  }
  prune() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.remove(key);
  }
  get(key: string): T | undefined {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T) {
    this.prune();
    this.remove(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, expires: this.now() + this.ttl });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
