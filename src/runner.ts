import type { PooledSession } from '@browsercash/pool';
import { AbortError, combineSignals, isAbortError, raceWithSignal, scheduleTimeout } from './abort.js';
import type { CrawlResult } from './scraper.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

/**
 * Structural subset of SessionPool that the runner depends on.
 *
 * Depending on the shape (instead of the concrete class) lets the runner be
 * exercised against a local mock pool without a Browser.cash connection.
 */
export interface SessionPoolLike {
  acquire(): Promise<PooledSession>;
  release(session: PooledSession, error?: boolean): void;
  stats(): { maxSize: number; available: number; inUse: number; waiting: number; total: number; creating: number };
  /**
   * Optional test/mock hook: reject queued acquire() callers when the runner
   * abandons its wait. The production SessionPool does not implement this;
   * in that case the late-resolution release path below prevents leaks.
   */
  abortWaiters?(message?: string): void;
}

/**
 * A single scrape job together with its original SERP position, so results can
 * be written back in SERP order regardless of completion order.
 */
export interface CrawlJob {
  url: string;
  index: number;
}

export interface RunCrawlOptions {
  /** Jobs in SERP order; results are returned in the same order. */
  jobs: CrawlJob[];
  pool: SessionPoolLike;
  /**
   * Worker count. Each worker holds at most one browser session at a time and
   * processes one URL per session checkout.
   */
  concurrency: number;
  /** Overall deadline for the whole batch, including waits for sessions. */
  timeoutMs: number;
  /** External cancellation (e.g. client disconnect). */
  externalSignal?: AbortSignal;
  /** The actual scrape work; receives the browser from the pooled session. */
  scrape: (browser: PooledSession['browser'], url: string, signal: AbortSignal) => Promise<CrawlResult>;
}

export interface RunCrawlOutcome {
  results: CrawlResult[];
  /** True when the run ended because of the overall timeout or external abort. */
  cancelled: boolean;
  timedOut: boolean;
}

/**
 * Acquire a session, failing fast once the deadline/cancellation fires.
 *
 * The underlying pool has no signal support: if a session resolves after we
 * have already given up waiting, it is released immediately (marked healthy —
 * we never used it) so it cannot leak out of the pool's accounting.
 */
export async function acquireWithDeadline(
  pool: SessionPoolLike,
  signal: AbortSignal
): Promise<PooledSession> {
  if (signal.aborted) {
    throw new AbortError('session acquire aborted before start');
  }

  const acquired = pool.acquire();
  try {
    return await raceWithSignal(acquired, signal, 'session acquire');
  } catch (err) {
    if (isAbortError(err)) {
      // Ask a signal-aware pool to settle its queued waiters; for the real
      // pool this is a no-op and the late-resolution path below handles it.
      pool.abortWaiters?.((err as Error).message);
      // Late resolution: hand the never-used session straight back to the pool.
      acquired.then(
        (session) => pool.release(session, false),
        () => undefined
      );
    }
    throw err;
  }
}

/**
 * Run a batch of scrape jobs with isolated context per URL.
 *
 * Guarantees:
 * - Every successfully acquired session is released exactly once, on every
 *   exit path (success, empty, error, timeout, external cancel).
 * - A session is recycled (release with error=true) only when a scrape that
 *   ran on it itself failed — one bad URL never poisons unrelated sessions.
 * - Healthy sessions are returned to the pool and reused by later jobs.
 * - Results are written at the original SERP index; every index gets either a
 *   real scrape result or a per-item error entry.
 * - The whole run is bounded by `timeoutMs` and can be cancelled externally.
 */
export async function runCrawlWithPool(options: RunCrawlOptions): Promise<RunCrawlOutcome> {
  const { jobs, pool, concurrency, timeoutMs, externalSignal, scrape } = options;

  const results: CrawlResult[] = new Array(jobs.length);
  const internal = new AbortController();
  const { signal, cleanup } = combineSignals(externalSignal, internal.signal);
  const cancelTimeout = scheduleTimeout(internal, timeoutMs, 'crawl');

  let next = 0;
  let timedOut = false;

  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));

  const worker = async (workerId: number): Promise<void> => {
    while (!signal.aborted) {
      const jobIndex = next++;
      if (jobIndex >= jobs.length) return;
      const job = jobs[jobIndex];

      let session: PooledSession | null = null;
      // Default to recycling on any abnormal exit; the success path resets this.
      let releaseWithError = true;

      try {
        session = await acquireWithDeadline(pool, signal);

        const result = await scrape(session.browser, job.url, signal);
        results[job.index] = result;
        // Recycling is decided by THIS session's own scrape outcome only.
        releaseWithError = result.status === 'error';
      } catch (err) {
        if (isAbortError(err)) {
          timedOut = timedOut || (err as AbortError).timedOut;
          if (DEBUG_LOG) {
            console.warn(`[runner] worker ${workerId} stopped for ${job.url}: ${(err as Error).message}`);
          }
          // Jobs not reached before the abort are filled with per-item errors
          // in the final pass below; this worker simply stops taking new work.
        } else {
          // Acquire failed (pool error) or scrape threw despite its contract:
          // record a per-item error but keep the batch alive.
          const message = err instanceof Error ? err.message : String(err);
          results[job.index] = { url: job.url, title: '', markdown: '', status: 'error', error: message };
          if (DEBUG_LOG) {
            console.error(`[runner] worker ${workerId} job failed for ${job.url}:`, message);
          }
        }
      } finally {
        // Single release point: every successfully acquired session is
        // returned exactly once, whatever path the job took.
        if (session) {
          pool.release(session, releaseWithError);
          session = null;
        }
      }

      if (signal.aborted) return;
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  } finally {
    cancelTimeout();
    cleanup();
  }

  // Every SERP position must carry a result — fill anything the workers never
  // reached (timeout/cancel while queued, or acquire rejected at shutdown).
  const cancelled = signal.aborted;
  if (cancelled) {
    timedOut = timedOut || (internal.signal.reason instanceof AbortError && internal.signal.reason.timedOut);
  }
  for (let i = 0; i < jobs.length; i++) {
    if (results[i] === undefined) {
      const reason = timedOut
        ? `crawl timed out after ${timeoutMs}ms before URL was processed`
        : 'crawl cancelled before URL was processed';
      results[i] = { url: jobs[i].url, title: '', markdown: '', status: 'error', error: reason };
    }
  }

  return { results, cancelled, timedOut };
}
