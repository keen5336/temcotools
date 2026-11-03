/** Zero backlog. Invalidation drops late answers without admitting another job until the old job exits. */
export class SingleFlight {
  private busy = false;
  private generation = 0;
  get running() {
    return this.busy;
  }
  invalidate() {
    this.generation++;
  }
  async run<T>(
    job: (isCurrent: () => boolean) => Promise<T>,
    publish: (value: T) => void,
  ): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const generation = this.generation;
    try {
      const value = await job(() => generation === this.generation);
      if (generation === this.generation) publish(value);
      return true;
    } finally {
      this.busy = false;
    }
  }
}
