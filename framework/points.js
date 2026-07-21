'use strict';

/**
 * points.js — a shared point/currency ledger service.
 *
 * A LEDGER is an independent point economy identified by a string id. Apps that
 * open the same ledger id share the same balances — that's how points move
 * across apps. Each ledger keeps its own accounts, transaction log, and config,
 * and can be deleted wholesale with deleteLedger(id).
 *
 * Accounts are plain strings. Conventions:
 *   'user:<authUserId>'  a signed-in user's wallet
 *   '@pool'              where periodic emission lands (default)
 *   '@owner'             the app/site owner's account
 *   (any other string an app wants, e.g. '@escrow:game1')
 *
 * Ledger config (fixed at creation; later ledger() calls can't change it):
 *   initial:  { amount, to: '@pool' }               points minted at creation
 *   emission: { amount, period: 'daily'|'weekly'|'monthly'|<ms> , to: '@pool' }
 *             minted LAZILY: whenever the ledger is touched, all periods that
 *             have fully elapsed since creation are minted exactly once.
 *   fiat:     { USD: { minorPerPoint: 1 }, NGN: { minorPerPoint: 150 }, ... }
 *             exchange rates for buying/redeeming points, in the currency's
 *             minor unit (cents/pence/kobo) per point. Integer.
 *
 * All amounts are positive safe integers. Balances never go negative: transfers
 * and burns fail with a clear error instead. Persistence is MongoDB when a
 * mongoUri is configured (atomic conditional updates), otherwise in-memory for
 * dev (single process only).
 */

const PERIODS = { daily: 864e5, weekly: 7 * 864e5, monthly: 30 * 864e5 };

const intAmount = (n) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('amount must be a positive integer');
  return n;
};
const periodMs = (p) => {
  if (typeof p === 'number' && p > 0) return p;
  if (PERIODS[p]) return PERIODS[p];
  throw new Error("emission.period must be 'daily', 'weekly', 'monthly', or a positive ms number");
};

class PointsService {
  constructor(options = {}) {
    // Injectable time source: production uses the real clock; tests can drive
    // game clock and ledger clock together so emission math is deterministic.
    this.now = options.now || (() => Date.now());
    this.mongoUri = options.mongoUri || null;
    this.dbName = options.dbName || 'app_framework';
    this.enabled = !!this.mongoUri;
    this._client = null;
    this._db = null;
    // memory fallback
    this._meta = new Map();      // ledgerId -> meta
    this._cache = new Map();     // ledgerId -> { config, epoch, mintedPeriods } (config is immutable)
    this._acct = new Map();      // `${ledger}:${account}` -> balance
    this._tx = [];               // {ledger, from, to, amount, kind, memo, at}
    this._purchases = new Map(); // ref -> purchase
  }

  async connect() {
    if (!this.mongoUri) { console.log('[points] No MONGO_URI — ledgers held in memory.'); return this; }
    const { MongoClient } = require('mongodb');
    this._client = new MongoClient(this.mongoUri, { serverSelectionTimeoutMS: 3000 });
    try {
      await this._client.connect();
      this._db = this._client.db(this.dbName);
      await this._db.collection('points_accounts').createIndex({ ledger: 1, account: 1 }, { unique: true });
      await this._db.collection('points_tx').createIndex({ ledger: 1, at: -1 });
      console.log('[points] Ledgers persisted to MongoDB.');
    } catch (e) {
      console.warn('[points] Mongo unavailable (' + e.message + ') — ledgers held in memory.');
      this._client = null; this._db = null; this.enabled = false;
    }
    return this;
  }
  async close() { if (this._client) { try { await this._client.close(); } catch (e) {} } }

  /** Open a ledger handle. `defaults` are applied only if the ledger doesn't exist yet. */
  ledger(id, defaults) { return new Ledger(this, String(id), defaults || null); }

  async ledgerExists(id) {
    if (this._db) return !!(await this._db.collection('points_meta').findOne({ _id: String(id) }, { projection: { _id: 1 } }));
    return this._meta.has(String(id));
  }
  async listLedgers() {
    if (this._db) return (await this._db.collection('points_meta').find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    return [...this._meta.keys()];
  }
  /** Remove a ledger and ALL its data (accounts, transactions, purchases). */
  async deleteLedger(id) {
    id = String(id);
    this._cache.delete(id);
    if (this._db) {
      await this._db.collection('points_meta').deleteOne({ _id: id });
      await this._db.collection('points_accounts').deleteMany({ ledger: id });
      await this._db.collection('points_tx').deleteMany({ ledger: id });
      await this._db.collection('points_purchases').deleteMany({ ledger: id });
      return true;
    }
    this._meta.delete(id);
    for (const k of [...this._acct.keys()]) if (k.startsWith(id + ':')) this._acct.delete(k);
    this._tx = this._tx.filter((t) => t.ledger !== id);
    for (const [k, p] of [...this._purchases]) if (p.ledger === id) this._purchases.delete(k);
    return true;
  }

  // ---- purchases (fiat -> points), consumed by payment webhooks ------------
  async recordPurchase(p) {
    const doc = { ...p, at: this.now() };
    if (this._db) await this._db.collection('points_purchases').updateOne({ _id: p.ref }, { $setOnInsert: doc }, { upsert: true });
    else if (!this._purchases.has(p.ref)) this._purchases.set(p.ref, doc);
    return doc;
  }
  async getPurchase(ref) {
    if (this._db) return this._db.collection('points_purchases').findOne({ _id: ref });
    return this._purchases.get(ref) || null;
  }
  /** One account's purchase/payout records on a ledger, newest first. */
  async listPurchases(ledger, account, limit = 50) {
    limit = Math.min(200, Math.max(1, Math.floor(limit) || 50));
    if (this._db) {
      return this._db.collection('points_purchases')
        .find({ ledger, account }).sort({ at: -1 }).limit(limit).toArray();
    }
    return [...this._purchases.values()]
      .filter((p) => p.ledger === ledger && p.account === account)
      .sort((a, b) => b.at - a.at).slice(0, limit);
  }
  /** Mark a pending purchase cancelled exactly once (releases its reservation). */
  async cancelPurchase(ref) {
    if (this._db) {
      const r = await this._db.collection('points_purchases').updateOne({ _id: ref, status: 'pending' }, { $set: { status: 'cancelled', cancelledAt: Date.now() } });
      return r.modifiedCount === 1;
    }
    const p = this._purchases.get(ref);
    if (!p || p.status !== 'pending') return false;
    p.status = 'cancelled'; p.cancelledAt = Date.now();
    return true;
  }

  /** Mark a purchase complete exactly once; returns true only for the first caller. */
  async completePurchase(ref) {
    if (this._db) {
      const r = await this._db.collection('points_purchases').updateOne({ _id: ref, status: 'pending' }, { $set: { status: 'complete', completedAt: Date.now() } });
      return r.modifiedCount === 1;
    }
    const p = this._purchases.get(ref);
    if (!p || p.status !== 'pending') return false;
    p.status = 'complete'; p.completedAt = Date.now();
    return true;
  }
}

class Ledger {
  constructor(service, id, defaults) { this.svc = service; this.id = id; this.defaults = defaults; }

  // ---- meta ----------------------------------------------------------------
  async _loadMeta() {
    const db = this.svc._db;
    if (db) {
      let m = await db.collection('points_meta').findOne({ _id: this.id });
      if (!m && this.defaults) m = await this._create(this.defaults);
      return m;
    }
    let m = this.svc._meta.get(this.id);
    if (!m && this.defaults) m = await this._create(this.defaults);
    return m || null;
  }

  async _create(cfg) {
    let epoch = this.svc.now();
    if (cfg.emission && cfg.emission.epoch != null) {
      if (!Number.isFinite(cfg.emission.epoch) || cfg.emission.epoch > this.svc.now()) throw new Error('emission.epoch must be a past ms timestamp');
      epoch = cfg.emission.epoch;
    }
    const config = {
      initial: cfg.initial && cfg.initial.amount ? { amount: intAmount(cfg.initial.amount), to: cfg.initial.to || '@pool' } : null,
      emission: cfg.emission ? { amount: intAmount(cfg.emission.amount), periodMs: periodMs(cfg.emission.period), to: cfg.emission.to || '@pool' } : null,
      fiat: cfg.fiat || null,
      // The market holds the points that are FOR SALE. Purchases transfer from
      // it (points are never minted for money); redemptions return points to it.
      // maxPremium scales the price as the market drains (see quote()).
      market: cfg.fiat ? {
        account: (cfg.market && cfg.market.account) || '@market',
        escrow: (cfg.market && cfg.market.escrow) || '@escrow',
        maxPremium: (cfg.market && cfg.market.maxPremium) || 4,
      } : null,
      name: cfg.name || this.id,
    };
    const meta = { _id: this.id, config, epoch, mintedPeriods: 0, totalSupply: 0, createdAt: this.svc.now() };
    const db = this.svc._db;
    if (db) {
      try { await db.collection('points_meta').insertOne(meta); }
      catch (e) { return db.collection('points_meta').findOne({ _id: this.id }); } // raced: someone else created it
    } else {
      this.svc._meta.set(this.id, meta);
    }
    if (config.initial) await this._mintRaw(config.initial.to, config.initial.amount, 'initial supply', 'mint');
    const created = await this._loadMetaRaw();
    if (created) this.svc._cache.set(this.id, { config: created.config, epoch: created.epoch, mintedPeriods: created.mintedPeriods });
    return created;
  }
  async _loadMetaRaw() {
    if (this.svc._db) return this.svc._db.collection('points_meta').findOne({ _id: this.id });
    return this.svc._meta.get(this.id) || null;
  }

  async exists() { return this.svc._cache.has(this.id) || !!(await this._loadMetaRaw()); }

  /**
   * Cached view of the ledger's immutable config + emission bookkeeping. This
   * is what makes reads fast: config/epoch never change after creation, and
   * mintedPeriods only needs the store when a mint is actually due, so the hot
   * path (every balance/info/state read) costs ZERO meta queries.
   */
  async _cachedMeta() {
    const hit = this.svc._cache.get(this.id);
    if (hit) return hit;
    const meta = await this._loadMeta();
    if (!meta) return null;
    const entry = { config: meta.config, epoch: meta.epoch, mintedPeriods: meta.mintedPeriods };
    this.svc._cache.set(this.id, entry);
    return entry;
  }

  /** Mint any fully-elapsed emission periods exactly once (idempotent, race-safe). */
  async mintOwed(now = this.svc.now()) {
    const c = await this._cachedMeta();
    if (!c || !c.config.emission) return 0;
    const { amount, periodMs: pm, to } = c.config.emission;
    if (Math.floor((now - c.epoch) / pm) <= c.mintedPeriods) return 0; // hot path: no queries
    // A mint looks due — confirm against the store (another process may have minted).
    const meta = await this._loadMetaRaw();
    if (!meta) return 0;
    c.mintedPeriods = meta.mintedPeriods;
    const owed = Math.floor((now - meta.epoch) / pm);
    if (owed <= meta.mintedPeriods) return 0;
    const delta = owed - meta.mintedPeriods;
    const db = this.svc._db;
    if (db) {
      // compare-and-set so concurrent workers can't double-mint
      const r = await db.collection('points_meta').updateOne(
        { _id: this.id, mintedPeriods: meta.mintedPeriods },
        { $set: { mintedPeriods: owed } });
      if (r.modifiedCount !== 1) { // someone else minted — refresh the cache
        const fresh = await this._loadMetaRaw();
        if (fresh) c.mintedPeriods = fresh.mintedPeriods;
        return 0;
      }
    } else {
      meta.mintedPeriods = owed;
    }
    c.mintedPeriods = owed;
    await this._mintRaw(to, delta * amount, `emission x${delta}`, 'emission');
    return delta * amount;
  }

  // ---- balances & moves ------------------------------------------------------
  async balance(account) {
    await this.mintOwed();
    return this._balanceRaw(account);
  }
  async _balanceRaw(account) {
    const db = this.svc._db;
    if (db) {
      const d = await db.collection('points_accounts').findOne({ ledger: this.id, account });
      return d ? d.balance : 0;
    }
    return this.svc._acct.get(this.id + ':' + account) || 0;
  }

  async _credit(account, amount) {
    const db = this.svc._db;
    if (db) {
      await db.collection('points_accounts').updateOne(
        { ledger: this.id, account }, { $inc: { balance: amount } }, { upsert: true });
    } else {
      const k = this.id + ':' + account;
      this.svc._acct.set(k, (this.svc._acct.get(k) || 0) + amount);
    }
  }
  /** Conditional debit: fails (returns false) if funds are insufficient. */
  async _debit(account, amount) {
    const db = this.svc._db;
    if (db) {
      const r = await db.collection('points_accounts').updateOne(
        { ledger: this.id, account, balance: { $gte: amount } }, { $inc: { balance: -amount } });
      return r.modifiedCount === 1;
    }
    const k = this.id + ':' + account;
    const bal = this.svc._acct.get(k) || 0;
    if (bal < amount) return false;
    this.svc._acct.set(k, bal - amount);
    return true;
  }
  async _supply(delta) {
    const db = this.svc._db;
    if (db) await db.collection('points_meta').updateOne({ _id: this.id }, { $inc: { totalSupply: delta } });
    else { const m = this.svc._meta.get(this.id); if (m) m.totalSupply += delta; }
  }
  async _log(from, to, amount, kind, memo) {
    const tx = { ledger: this.id, from, to, amount, kind, memo: memo || '', at: this.svc.now() };
    if (this.svc._db) await this.svc._db.collection('points_tx').insertOne(tx);
    else { this.svc._tx.push(tx); if (this.svc._tx.length > 10000) this.svc._tx.shift(); }
    return tx;
  }

  async _mintRaw(to, amount, memo, kind) {
    await this._credit(to, amount);
    await this._supply(amount);
    await this._log(null, to, amount, kind || 'mint', memo);
  }

  /** Create new points out of thin air (server-side/trusted code only). */
  async mint(to, amount, memo) {
    intAmount(amount);
    if (!(await this._loadMeta())) throw new Error(`Ledger "${this.id}" does not exist`);
    await this._mintRaw(to, amount, memo, 'mint');
    return { to, amount };
  }

  /** Destroy points from an account (reduces total supply). */
  async burn(from, amount, memo) {
    intAmount(amount);
    await this.mintOwed();
    if (!(await this._debit(from, amount))) throw new Error(`Insufficient points: "${from}" has ${await this._balanceRaw(from)}, needs ${amount}`);
    await this._supply(-amount);
    await this._log(from, null, amount, 'burn', memo);
    return { from, amount };
  }

  /** Move points between any two accounts. Fails cleanly on insufficient funds. */
  async transfer(from, to, amount, memo) {
    intAmount(amount);
    if (!from || !to || from === to) throw new Error('transfer needs two different accounts');
    await this.mintOwed();
    if (!(await this._debit(from, amount))) throw new Error(`Insufficient points: "${from}" has ${await this._balanceRaw(from)}, needs ${amount}`);
    await this._credit(to, amount);
    return this._log(from, to, amount, 'transfer', memo);
  }

  /** Convenience for "pay to use a feature": user pays the app owner (or burns). */
  async charge(userAccount, amount, memo, { to = '@owner' } = {}) {
    if (to === null) return this.burn(userAccount, amount, memo);
    return this.transfer(userAccount, to, amount, memo);
  }

  /**
   * Price a purchase against the market. Points are NEVER minted for money:
   * only what the market account holds can be bought, and the unit price rises
   * with scarcity. premium = 1x when the market holds the whole supply, rising
   * linearly to maxPremium as it approaches empty. Integer math in basis points.
   */
  async quote(points, currency) {
    intAmount(points);
    const c = await this._cachedMeta();
    if (!c) throw new Error(`Ledger "${this.id}" does not exist`);
    if (!c.config.market) throw new Error('This ledger has no market (no fiat config).');
    const rate = c.config.fiat && c.config.fiat[String(currency || '').toUpperCase()];
    if (!rate) throw new Error(`Currency not supported by this ledger. Available: ${Object.keys(c.config.fiat || {}).join(', ')}`);
    await this.mintOwed();
    const [available, meta] = await Promise.all([this._balanceRaw(c.config.market.account), this._loadMetaRaw()]);
    const supply = meta.totalSupply;
    const ratio = supply > 0 ? Math.min(1, available / supply) : 0;
    const premiumBp = 10000 + Math.round((1 - ratio) * (c.config.market.maxPremium - 1) * 10000);
    return {
      points, currency: String(currency).toUpperCase(),
      available, totalSupply: supply,
      unitMinorBase: rate.minorPerPoint, premiumBp,
      amountMinor: Math.ceil((points * rate.minorPerPoint * premiumBp) / 10000),
      canFill: points <= available,
      marketAccount: c.config.market.account, escrowAccount: c.config.market.escrow,
    };
  }

  async info() {
    await this.mintOwed();
    const c = await this._cachedMeta();
    if (!c) return null;
    const em = c.config.emission;
    const mk = c.config.market;
    // one parallel batch instead of a chain of sequential round trips
    const [meta, pool, available] = await Promise.all([
      this._loadMetaRaw(),                                   // fresh totalSupply
      this._balanceRaw(em ? em.to : '@pool'),
      mk ? this._balanceRaw(mk.account) : Promise.resolve(0),
    ]);
    if (!meta) return null;
    const ratio = mk && meta.totalSupply > 0 ? Math.min(1, available / meta.totalSupply) : 0;
    return {
      id: this.id,
      name: c.config.name,
      totalSupply: meta.totalSupply,
      pool,
      emission: em ? { amount: em.amount, periodMs: em.periodMs, to: em.to, nextAt: c.epoch + (c.mintedPeriods + 1) * em.periodMs } : null,
      fiat: c.config.fiat || null,
      market: mk ? {
        account: mk.account, escrow: mk.escrow, available,
        maxPremium: mk.maxPremium,
        premiumBp: 10000 + Math.round((1 - ratio) * (mk.maxPremium - 1) * 10000),
      } : null,
      createdAt: meta.createdAt,
    };
  }

  async history(account, limit = 50) {
    limit = Math.min(Math.max(1, limit | 0), 200);
    if (this.svc._db) {
      const q = { ledger: this.id, ...(account ? { $or: [{ from: account }, { to: account }] } : {}) };
      return this.svc._db.collection('points_tx').find(q).sort({ at: -1 }).limit(limit).toArray();
    }
    let rows = this.svc._tx.filter((t) => t.ledger === this.id && (!account || t.from === account || t.to === account));
    return rows.slice(-limit).reverse();
  }
}

module.exports = { PointsService, Ledger };
