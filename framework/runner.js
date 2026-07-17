'use strict';

/**
 * Runner — drives a backend app's run(dt) method on a loop.
 *
 * Uses recursive setTimeout (not setInterval) and an in-flight guard so ticks
 * never overlap, even if a run() call takes longer than the interval. dt is the
 * real elapsed time in ms since the previous tick.
 */
class Runner {
  constructor(fn, intervalMs = 1000) {
    this.fn = fn;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.stopped = true;
    this.inFlight = false;
    this.last = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.last = Date.now();
    this._schedule();
  }

  _schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => this._tick(), this.intervalMs);
  }

  async _tick() {
    if (this.stopped || this.inFlight) { this._schedule(); return; }
    this.inFlight = true;
    const now = Date.now();
    const dt = now - this.last;
    this.last = now;
    try {
      await this.fn(dt);
    } catch (err) {
      console.error('[runner] run() threw:', err);
    } finally {
      this.inFlight = false;
      this._schedule();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

module.exports = Runner;
