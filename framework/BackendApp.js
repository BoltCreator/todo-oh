'use strict';

/**
 * BackendApp — the contract that every project's backend class fulfills.
 *
 * You do NOT have to extend this class. The framework feature-detects each
 * method, so any plain object or class that implements some subset of these
 * methods will work ("if available" semantics). Extending it just gives you
 * sensible no-op defaults and documents the interface.
 *
 * Lifecycle (managed by AppServer):
 *   1. new AppClass(options)         -> one shared singleton instance per server
 *   2. read(savedState)             -> if a saved snapshot exists in Mongo
 *   3. run(dt) on a loop            -> continuous backend updates (if defined)
 *   4. get(query, params, ctx)      -> frontend reads
 *      post(action, data, ctx)      -> frontend writes
 *   5. getJson()                    -> snapshot persisted to Mongo periodically
 */
class BackendApp {
  /**
   * @param {object} options - merged framework + app options (name, etc.)
   */
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Return the single-page HTML for the frontend as a string.
   * Plain, ordinary HTML is fine — the framework's compiler injects a small
   * client runtime so any `App.get(...)` / `App.post(...)` calls (and the
   * declarative data-* bindings) reach this class. Returning a static HTML
   * file works unchanged.
   * @returns {string}
   */
  getHTML() {
    return '<!doctype html><meta charset="utf-8"><title>App</title>' +
      '<h1>It works</h1><p>Override getHTML() to render your app.</p>';
  }

  /**
   * Called repeatedly by the framework (never overlapping with itself) so the
   * backend can update its own state continuously. Optional.
   * @param {number} dt - milliseconds since the previous tick
   */
  async run(/* dt */) {}

  /**
   * Handle a read request from the frontend (App.get(query, params)).
   * Return any JSON-serializable value. Optional.
   * @param {string} query
   * @param {object} params
   * @param {object} ctx - { ip, headers }
   */
  async get(/* query, params, ctx */) {
    return null;
  }

  /**
   * Handle a write/update from the frontend (App.post(action, data)).
   * Return any JSON-serializable value (commonly the new state). Optional.
   * @param {string} action
   * @param {object} data
   * @param {object} ctx - { ip, headers }
   */
  async post(/* action, data, ctx */) {
    return null;
  }

  /**
   * Return the current state as a JSON-serializable object. The framework
   * persists this to MongoDB on an interval and on graceful shutdown.
   * Optional — if absent, the app simply isn't persisted.
   * @returns {object}
   */
  getJson() {
    return {};
  }

  /**
   * Restore state from a previously saved getJson() snapshot. Called once on
   * startup if a snapshot exists. Optional.
   * @param {object} json
   */
  read(/* json */) {}
}

module.exports = BackendApp;
