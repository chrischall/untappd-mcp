import { DurableObject } from 'cloudflare:workers';
import {
  CheckinStoreCore,
  type CacheStore,
  type CheckinRow,
  type HasHadResult,
  type QueryFilters,
  type SqlDriver,
  type SqlParam,
  type SyncState,
} from './store.js';

// The Cloudflare Durable Object backend for the check-in cache, used by the
// remote connector (src/worker.ts). The connector's own MCP agent DO is keyed
// per session (per conversation) and so its storage is ephemeral; this is a
// SEPARATE, durable DO keyed by the authenticated operator's username
// (idFromName), so one cache persists across all of that user's conversations.
// Keying by the operator (never the subject being queried) means a user's cache
// only ever holds check-ins their own account was allowed to fetch — a friend's
// friends-only history a different operator synced is never visible here.

/** Adapts a Durable Object's SQLite storage to the driver the core needs. */
class SqlStorageDriver implements SqlDriver {
  constructor(private readonly storage: DurableObjectStorage) {}
  private get sql(): SqlStorage {
    return this.storage.sql;
  }
  execScript(sql: string): void {
    this.sql.exec(sql);
  }
  run(sql: string, params: SqlParam[]): void {
    this.sql.exec(sql, ...params);
  }
  get(sql: string, params: SqlParam[]): Record<string, unknown> | undefined {
    return this.sql.exec(sql, ...params).toArray()[0] as Record<string, unknown> | undefined;
  }
  all(sql: string, params: SqlParam[]): Record<string, unknown>[] {
    return this.sql.exec(sql, ...params).toArray() as Record<string, unknown>[];
  }
  transaction(fn: () => void): void {
    // SQLite-backed DO storage runs a synchronous closure atomically.
    this.storage.transactionSync(fn);
  }
}

/**
 * Per-operator durable cache Durable Object. Its public async methods are the
 * RPC surface {@link DurableCacheStore} calls; each delegates to the shared
 * synchronous core over this DO's SQLite storage.
 */
export class UntappdCacheDO extends DurableObject {
  private readonly core: CheckinStoreCore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.core = new CheckinStoreCore(new SqlStorageDriver(ctx.storage));
  }

  async upsertCheckins(username: string, rows: CheckinRow[]): Promise<number> {
    return this.core.upsertCheckins(username, rows);
  }
  async cachedCount(username: string): Promise<number> {
    return this.core.cachedCount(username);
  }
  async distinctBeerCount(username: string): Promise<number> {
    return this.core.distinctBeerCount(username);
  }
  async newestCachedId(username: string): Promise<number | null> {
    return this.core.newestCachedId(username);
  }
  async getState(username: string): Promise<SyncState | undefined> {
    return this.core.getState(username);
  }
  async setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): Promise<void> {
    this.core.setState(username, patch);
  }
  async hasHad(username: string, opts: { bid?: number; beerName?: string }): Promise<HasHadResult> {
    return this.core.hasHad(username, opts);
  }
  async query(username: string, filters: QueryFilters): Promise<CheckinRow[]> {
    return this.core.query(username, filters);
  }
}

/** A {@link CacheStore} that forwards every call to an {@link UntappdCacheDO} stub. */
class DurableCacheStore implements CacheStore {
  constructor(private readonly stub: DurableObjectStub<UntappdCacheDO>) {}
  upsertCheckins(username: string, rows: CheckinRow[]): Promise<number> {
    return this.stub.upsertCheckins(username, rows);
  }
  cachedCount(username: string): Promise<number> {
    return this.stub.cachedCount(username);
  }
  distinctBeerCount(username: string): Promise<number> {
    return this.stub.distinctBeerCount(username);
  }
  newestCachedId(username: string): Promise<number | null> {
    return this.stub.newestCachedId(username);
  }
  getState(username: string): Promise<SyncState | undefined> {
    return this.stub.getState(username);
  }
  setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): Promise<void> {
    return this.stub.setState(username, patch);
  }
  hasHad(username: string, opts: { bid?: number; beerName?: string }): Promise<HasHadResult> {
    return this.stub.hasHad(username, opts);
  }
  query(username: string, filters: QueryFilters): Promise<CheckinRow[]> {
    return this.stub.query(username, filters);
  }
}

/**
 * Build a {@link CacheStore} backed by the operator's durable cache DO. Keyed by
 * `idFromName(operatorUsername)` so every one of that user's sessions shares one
 * persistent cache.
 */
export function makeDurableCacheStore(
  namespace: DurableObjectNamespace<UntappdCacheDO>,
  operatorUsername: string,
): CacheStore {
  const id = namespace.idFromName(operatorUsername.toLowerCase());
  return new DurableCacheStore(namespace.get(id));
}
