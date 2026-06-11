// EpochTracker：乐观锁书签（DEV_PLAN §2.2）。
// resync 后必须 setBookmark(snapshot.lastSeq, snapshot.epoch) 再 connect——关键坑④。
export class EpochTracker {
  private _epoch = 0;
  private _lastSeq = 0;

  get epoch(): number {
    return this._epoch;
  }
  get lastSeq(): number {
    return this._lastSeq;
  }

  setBookmark(lastSeq: number, epoch: number): void {
    this._lastSeq = lastSeq;
    this._epoch = epoch;
  }

  /** 消费事件后推进书签；epoch 只增不减 */
  advance(seq: number, epoch: number): void {
    if (seq > this._lastSeq) this._lastSeq = seq;
    if (epoch > this._epoch) this._epoch = epoch;
  }
}
