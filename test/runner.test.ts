import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runCrawlWithPool, type SessionPoolLike } from '../src/runner.js';
import type { CrawlResult } from '../src/scraper.js';
import { MockPool, MockBrowser, MockContext, type MockPageOptions } from './mocks/browser-pool.js';

/**
 * Scrape function used by the runner tests: honours the same isolation
 * contract as the real scraper (fresh context per call) and the same abort
 * contract (signal abort closes the in-flight page). Failures are injected per
 * URL via `failingUrls`.
 */
function makeScrape(deps: {
  failingUrls?: Set<string>;
  onScrape?: (info: { url: string; sessionId: string; context: MockContext }) => void;
}) {
  return async function scrape(
    browser: MockBrowser,
    url: string,
    signal: AbortSignal
  ): Promise<CrawlResult> {
    // Use the same fresh-context-per-scrape contract as src/scraper.ts.
    const context = (await (browser as unknown as MockBrowser).newContext()) as MockContext;
    let page: Awaited<ReturnType<MockContext['newPage']>> | null = null;
    // Mirror the production abortPageOnSignal() bridge: aborting the signal
    // closes the in-flight page so a blocked navigation rejects promptly.
    const onAbort = () => void page?.close().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) {
        return { url, title: '', markdown: '', status: 'error', error: signal.reason?.message ?? 'aborted' };
      }
      page = await context.newPage();
      try {
        await page.goto(url);
      } catch (err) {
        if (signal.aborted) {
          return {
            url,
            title: '',
            markdown: '',
            status: 'error',
            error: signal.reason?.message ?? (err as Error).message,
          };
        }
        throw err;
      }

      if (deps.failingUrls?.has(url)) {
        await page.close();
        return { url, title: '', markdown: '', status: 'error', error: `forced failure for ${url}` };
      }

      deps.onScrape?.({ url, sessionId: browser.sessionId, context });
      // Simulate the site writing state inside this scrape's own context.
      context.setCookie('sid', `cookie-for-${url}`);
      await page.close();
      return {
        url,
        title: `title of ${url}`,
        markdown: `# ${url} ${'content '.repeat(40)}`,
        status: 'success',
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      await context.close();
    }
  };
}

describe('runCrawlWithPool', () => {
  test('reuses healthy sessions but gives every scrape an isolated context', async () => {
    const pool = new MockPool({ size: 2 });
    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`);
    const jobs = urls.map((url, index) => ({ url, index }));

    const seen = new Map<string, { contexts: MockContext[]; cookies: string[] }>();
    const scrape = makeScrape({
      onScrape: ({ sessionId, context }) => {
        const entry = seen.get(sessionId) ?? { contexts: [], cookies: [] };
        entry.contexts.push(context);
        entry.cookies.push([...context.cookies.values()].join(','));
        seen.set(sessionId, entry);
      },
    });

    const { results, cancelled } = await runCrawlWithPool({
      jobs,
      pool: pool as unknown as SessionPoolLike,
      concurrency: 2,
      timeoutMs: 10_000,
      scrape: scrape as never,
    });

    assert.equal(cancelled, false);
    assert.equal(results.length, 6);
    assert.ok(results.every((r) => r.status === 'success'));

    // Only the two pre-warmed sessions should have been used: healthy reuse.
    const usedSessionIds = [...seen.keys()];
    assert.ok(usedSessionIds.length <= 2, `expected <=2 sessions, got ${usedSessionIds.length}`);

    // Each session saw multiple scrapes, but every scrape got its own context.
    for (const [, entry] of seen) {
      assert.ok(entry.contexts.length >= 1);
      const unique = new Set(entry.contexts);
      assert.equal(unique.size, entry.contexts.length, 'contexts must not be reused across scrapes');
      // Every context started with an empty jar: no cookie/storage bleed from
      // previous scrapes that ran on the same browser session.
      assert.ok(entry.cookies.every((jar) => jar === ''), `cookie jar leaked: ${entry.cookies.join('|')}`);
      // And every context was closed after use.
      assert.ok(entry.contexts.every((c) => c.closed), 'all contexts must be closed');
    }

    // Every acquire was released exactly once, all healthy.
    assert.equal(pool.acquireCount, 6);
    assert.equal(pool.releaseCount, 6);
    assert.ok(pool.releases.every((r) => r.error === false));
  });

  test('recycles only the session whose own scrape failed', async () => {
    const pool = new MockPool({ size: 3 });
    const urls = ['https://a.test', 'https://b.test', 'https://broken.test', 'https://c.test'];
    const jobs = urls.map((url, index) => ({ url, index }));
    const scrape = makeScrape({ failingUrls: new Set(['https://broken.test']) });

    const { results } = await runCrawlWithPool({
      jobs,
      pool: pool as unknown as SessionPoolLike,
      concurrency: 3,
      timeoutMs: 10_000,
      scrape: scrape as never,
    });

    // Per-item errors preserved in SERP order, other items unaffected.
    assert.deepEqual(results.map((r) => r.status), ['success', 'success', 'error', 'success']);
    assert.match(results[2].error ?? '', /forced failure/);

    // Exactly one release flagged error, and that session was destroyed.
    const errorReleases = pool.releases.filter((r) => r.error);
    assert.equal(errorReleases.length, 1);
    assert.ok(pool.isDestroyed(errorReleases[0].sessionId));

    // Still one release per acquire, no leaks; healthy sessions survived.
    assert.equal(pool.acquireCount, 4);
    assert.equal(pool.releaseCount, 4);
    const healthyReleases = pool.releases.filter((r) => !r.error);
    assert.ok(healthyReleases.every((r) => !pool.isDestroyed(r.sessionId)));
  });

  test('returns results in SERP order regardless of completion order', async () => {
    const pool = new MockPool({ size: 4 });
    // Earlier URLs are slower: completion order will be reverse of input order.
    const pageOptions = new Map<string, MockPageOptions>();
    const urls = Array.from({ length: 8 }, (_, i) => `https://order.test/${i}`);
    urls.forEach((url, i) => pageOptions.set(url, { gotoDelayMs: (urls.length - i) * 20 }));

    const { results } = await runCrawlWithPool({
      jobs: urls.map((url, index) => ({ url, index })),
      pool: pool as unknown as SessionPoolLike,
      concurrency: 4,
      timeoutMs: 10_000,
      scrape: (async (browser: MockBrowser, url: string) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(url);
        await context.close();
        return { url, title: url, markdown: 'ok', status: 'success' } as CrawlResult;
      }) as never,
    });

    assert.deepEqual(results.map((r) => r.url), urls);
    assert.equal(pool.releaseCount, pool.acquireCount);
  });

  test('overall timeout bounds session waits and fills unprocessed items with errors', async () => {
    // Single-session pool where every scrape outlasts the batch deadline: the
    // first worker grabs the only session, the rest block in acquire() and must
    // be unblocked by the overall timeout instead of waiting forever.
    const pool = new MockPool({
      size: 1,
      browserOptions: { contextOptions: { pageOptions: { gotoDelayMs: 5_000 } } },
    });
    const urls = Array.from({ length: 4 }, (_, i) => `https://slow-pool.test/${i}`);

    const start = Date.now();
    const { results, cancelled, timedOut } = await runCrawlWithPool({
      jobs: urls.map((url, index) => ({ url, index })),
      pool: pool as unknown as SessionPoolLike,
      concurrency: 4,
      timeoutMs: 150,
      scrape: makeScrape({}) as never,
    });
    const elapsed = Date.now() - start;

    assert.equal(cancelled, true);
    assert.equal(timedOut, true);
    assert.ok(elapsed < 1_500, `deadline not respected: ${elapsed}ms`);
    assert.equal(results.length, 4);
    assert.ok(results.every((r) => r.status === 'error'));
    assert.ok(results.every((r) => /timed out|aborted/.test(r.error ?? '')));
    assert.deepEqual(results.map((r) => r.url), urls, 'errors still follow SERP order');

    // Late-acquired sessions are handed back by acquireWithDeadline; give
    // microtasks a tick to settle and assert no checkout is left unreleased.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pool.releaseCount, pool.acquireCount);
  });

  test('external cancellation stops new work and releases every acquired session', async () => {
    // Two-session pool; scrapes are slow enough that only the first wave is in
    // flight when the external abort fires.
    const pool = new MockPool({
      size: 2,
      browserOptions: { contextOptions: { pageOptions: { gotoDelayMs: 500 } } },
    });
    const external = new AbortController();
    const urls = Array.from({ length: 10 }, (_, i) => `https://cancel.test/${i}`);

    // Cancel after the first two workers have acquired sessions and started.
    setTimeout(() => external.abort(new Error('client disconnected')), 80);

    const { results, cancelled, timedOut } = await runCrawlWithPool({
      jobs: urls.map((url, index) => ({ url, index })),
      pool: pool as unknown as SessionPoolLike,
      concurrency: 3,
      timeoutMs: 30_000,
      externalSignal: external.signal,
      scrape: makeScrape({}) as never,
    });

    assert.equal(cancelled, true);
    assert.equal(timedOut, false);
    assert.equal(results.length, 10);
    assert.deepEqual(results.map((r) => r.url), urls);
    // Nothing is left undefined; every item is either done or carries an error.
    assert.ok(results.every((r) => r.status === 'success' || r.status === 'error'));
    assert.ok(results.some((r) => /cancelled|disconnected/.test(r.error ?? '')));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pool.releaseCount, pool.acquireCount, 'all acquires must be released');
  });

  test('a rejected acquire becomes a per-item error without killing the batch', async () => {
    class FlakyPool extends MockPool {
      private calls = 0;
      override async acquire() {
        this.calls++;
        if (this.calls === 2) {
          // Simulate on-demand session creation failing at the pool level.
          // No session is produced, so nothing can be released for this job.
          throw new Error('pool create failed (mock)');
        }
        return super.acquire();
      }
    }
    const pool = new FlakyPool({ size: 3 });
    const urls = Array.from({ length: 5 }, (_, i) => `https://flaky.test/${i}`);

    const { results } = await runCrawlWithPool({
      jobs: urls.map((url, index) => ({ url, index })),
      pool: pool as unknown as SessionPoolLike,
      concurrency: 3,
      timeoutMs: 10_000,
      scrape: makeScrape({}) as never,
    });

    assert.equal(results.length, 5);
    assert.equal(results.filter((r) => r.status === 'error').length, 1);
    assert.match(results.find((r) => r.status === 'error')?.error ?? '', /pool create failed/);
    assert.equal(results.filter((r) => r.status === 'success').length, 4);
    // Exactly the 4 successful checkouts are released; the failed acquire
    // produced no session and therefore needs (and gets) no release.
    assert.equal(pool.releaseCount, 4);
    assert.equal(pool.acquireCount, 4);
    assert.ok(pool.releases.every((r) => r.error === false));
  });
});

describe('acquireWithDeadline late-resolution cleanup', () => {
  let originalWarn: typeof console.warn;
  let warnings: string[];
  beforeEach(() => {
    originalWarn = console.warn;
    warnings = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  });
  afterEach(() => {
    console.warn = originalWarn;
  });

  test('releases a session that resolves after the deadline fired', async () => {
    // The single acquire call is slow to resolve; the deadline fires first.
    const pool = new MockPool({ size: 1, acquireDelayForCall: new Map([[1, 300]]) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('deadline')), 50);

    const { acquireWithDeadline } = await import('../src/runner.js');
    await assert.rejects(
      () => acquireWithDeadline(pool as never, controller.signal),
      /deadline/
    );
    clearTimeout(timer);

    // The deadline won the race, so nothing was checked out yet.
    assert.equal(pool.releaseCount, 0);

    // The pending acquire still resolves later; acquireWithDeadline's
    // late-resolution path must hand that never-used session back, not leak it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pool.acquireCount, 1);
    assert.equal(pool.releaseCount, 1);
    assert.equal(pool.releases[0]?.error, false);
  });
});
