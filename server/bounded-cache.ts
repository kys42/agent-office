/** LRU with both entry and conservative retained-text budgets. Estimates are not RSS limits. */
export class BoundedCache<K, V> extends Map<K, V> {
  private weights = new Map<K, number>();
  bytes = 0;
  constructor(
    readonly budgetBytes: number,
    readonly maxEntries: number,
    private weigh: (value: V) => number = (value) => JSON.stringify(value).length * 2 + 256,
    private evicted?: (key: K, value: V) => void,
  ) {
    super();
  }
  override get(key: K): V | undefined {
    const value = super.get(key);
    if (super.has(key)) {
      super.delete(key);
      super.set(key, value!);
    }
    return value;
  }
  override set(key: K, value: V): this {
    this.delete(key);
    const weight = Math.max(1, this.weigh(value));
    if (weight > this.budgetBytes) return this;
    super.set(key, value);
    this.weights.set(key, weight);
    this.bytes += weight;
    while (this.bytes > this.budgetBytes || this.size > this.maxEntries) {
      const key = this.keys().next().value!;
      const value = super.get(key)!;
      this.delete(key);
      this.evicted?.(key, value);
    }
    return this;
  }
  override delete(key: K): boolean {
    this.bytes -= this.weights.get(key) ?? 0;
    this.weights.delete(key);
    return super.delete(key);
  }
  override clear(): void {
    super.clear();
    this.weights.clear();
    this.bytes = 0;
  }
}
