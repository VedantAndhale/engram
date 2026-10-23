/*
 * The requests the engine is waiting on from its worker, by key. When the worker goes (the model is unloaded or
 * removed), each one is ended with an error, so nothing waits on a worker that is gone and the queue behind it moves.
 */
export class Awaiting<K> {
  private ends = new Map<K, (err: Error) => void>();

  /** Remember how to end the request `key` if the worker goes first. */
  set(key: K, end: (err: Error) => void): void {
    this.ends.set(key, end);
  }

  /** The request `key` was answered, so it is not ended later. */
  delete(key: K): void {
    this.ends.delete(key);
  }

  /** End every request still waiting, with `err`. Each is ended once. */
  failAll(err: Error): void {
    const ends = [...this.ends.values()];
    this.ends.clear();
    for (const end of ends) end(err);
  }

  get size(): number {
    return this.ends.size;
  }
}
