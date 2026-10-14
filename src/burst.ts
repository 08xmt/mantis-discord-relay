/**
 * Counts events inside a sliding window and fires once each time the count
 * crosses the threshold (and again after it drops back under and re-crosses).
 */
export class BurstAlert {
  private readonly hits: number[] = [];
  private latched = false;

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly onBurst: (count: number) => void,
  ) {}

  hit(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] < cutoff) this.hits.shift();
    if (this.hits.length < this.threshold) this.latched = false;
    this.hits.push(nowMs);
    if (this.hits.length >= this.threshold && !this.latched) {
      this.latched = true;
      this.onBurst(this.hits.length);
    }
  }
}
