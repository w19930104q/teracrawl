import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerCrawlRoutes } from '../src/crawl.js';
import { __setPoolForTesting } from '../src/pool.js';
import { MockPool, type MockBrowser } from './mocks/browser-pool.js';
import type { CrawlResult } from '../src/scraper.js';

/**
 * HTTP-level integration tests. They wire the real Fastify routes to:
 *  - a mock SessionPool (no Browser.cash / network for browsers), and
 *  - a real scrape function shape implemented over the mock browsers,
 * so request/response contracts (/scrape field compatibility, /crawl ordering
 * and per-item errors, timeout status codes) are verified end-to-end.
 */

const SERP_PORTS: number[] = [];
let serpPort = 9911;

async function startFakeSerp(urls: string[]): Promise<{ url: string; stop: () => Promise<void> }> {
  const serp = Fastify();
  serp.post('/api/v1/search', async () => ({
    web: { results: urls.map((url) => ({ url, title: `t-${url}` })) },
  }));
  const port = serpPort++;
  SERP_PORTS.push(port);
  await serp.listen({ port, host: '127.0.0.1' });
  return { url: `http://127.0.0.1:${port}`, stop: () => serp.close() };
}

/** Build a mock browser whose scraper behaviour we control per URL. */
function makePool(behaviour: {
  failUrls?: Set<string>;
  gotoDelayMs?: number;
}): MockPool {
  return new MockPool({
    size: 3,
    browserOptions: {
      contextOptions: {
        pageOptions: { gotoDelayMs: behaviour.gotoDelayMs ?? 0 },
      },
    },
  });
}

/**
 * Replace the scraper behaviour by wrapping mock browsers directly inside the
 * route's scrape callback is not possible (routes import the real scraper), so
 * instead we assert on what the real scraper produces through mock pages.
 * The default MockPage yields valid long content => "success".
 */
describe('HTTP routes', () => {
  let app: FastifyInstance;
  let serp: { url: string; stop: () => Promise<void> } | null = null;
  let pool: MockPool | null = null;
  const originalSerpUrl = process.env.SERP_SERVICE_URL;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    // Settle any queued acquire waiters so no mock promise outlives the test.
    pool?.abortWaiters('test teardown');
    await app.close();
    await serp?.stop();
    serp = null;
    __setPoolForTesting(null);
    if (originalSerpUrl === undefined) delete process.env.SERP_SERVICE_URL;
    else process.env.SERP_SERVICE_URL = originalSerpUrl;
    delete process.env.SCRAPE_TIMEOUT_MS;
    pool = null;
  });

  test('POST /scrape returns the documented field shape on success', async () => {
    pool = makePool({});
    __setPoolForTesting(pool as never);
    await registerCrawlRoutes(app);

    const res = await app.inject({
      method: 'POST',
      url: '/scrape',
      payload: { url: 'https://shape.test/page' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as CrawlResult;
    assert.equal(body.url, 'https://shape.test/page');
    assert.equal(body.status, 'success');
    assert.equal(typeof body.title, 'string');
    assert.equal(typeof body.markdown, 'string');
    assert.equal(body.error, undefined);
    // Every checkout is released.
    assert.equal(pool.releaseCount, pool.acquireCount);
    assert.equal(pool.releases[0]?.error, false);
  });

  test('POST /scrape keeps url+error fields on a navigation failure', async () => {
    pool = new MockPool({
      size: 1,
      browserOptions: { contextOptions: { pageOptions: { gotoError: new Error('net::ERR_FAILED') } } },
    });
    __setPoolForTesting(pool as never);
    await registerCrawlRoutes(app);

    const res = await app.inject({
      method: 'POST',
      url: '/scrape',
      payload: { url: 'https://broken.test' },
    });

    // The scrape runs and returns an error result body with 200 (unchanged
    // contract), and its failed session is recycled exactly once.
    assert.equal(res.statusCode, 200);
    const body = res.json() as CrawlResult;
    assert.equal(body.url, 'https://broken.test');
    assert.equal(body.status, 'error');
    assert.equal(body.title, '');
    assert.equal(body.markdown, '');
    assert.match(body.error ?? '', /ERR_FAILED/);
    assert.equal(pool.releaseCount, 1);
    assert.equal(pool.releases[0]?.error, true);
  });

  test('POST /scrape honors a total deadline when no session is available', async () => {
    // A single-session pool whose only session is never released: the request
    // must give up at SCRAPE_TIMEOUT_MS instead of waiting on the pool forever.
    process.env.SCRAPE_TIMEOUT_MS = '100';
    const exhausted = new MockPool({ size: 1 });
    // Hold the only session for the whole test.
    const held = await exhausted.acquire();
    __setPoolForTesting(exhausted as never);
    await registerCrawlRoutes(app);

    const start = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/scrape',
      payload: { url: 'https://queued.test' },
    });
    const elapsed = Date.now() - start;

    assert.equal(res.statusCode, 504);
    assert.equal(res.json().error, 'scrape_failed');
    assert.ok(elapsed < 1_000, `deadline not enforced: ${elapsed}ms`);

    // Settle the queued acquire and hand back the held session so no mock
    // promise or checkout outlives the test (the request's own acquire was
    // rejected by the deadline and produced no session).
    exhausted.abortWaiters('test teardown');
    exhausted.release(held, false);
    assert.equal(exhausted.releaseCount, 1);
    delete process.env.SCRAPE_TIMEOUT_MS;
  });

  test('POST /scrape validates input and rejects PDF without API key', async () => {
    pool = makePool({});
    __setPoolForTesting(pool as never);
    await registerCrawlRoutes(app);

    const badUrl = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'ftp://x' } });
    assert.equal(badUrl.statusCode, 400);
    assert.equal(badUrl.json().error, 'valid_url_required');

    const pdf = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'https://x/doc.pdf' } });
    assert.equal(pdf.statusCode, 400);
    assert.equal(pdf.json().error, 'pdf_not_supported');
    // No session was consumed for rejected input.
    assert.equal(pool.acquireCount, 0);
  });

  test('POST /crawl returns results in SERP order with isolated contexts and healthy reuse', async () => {
    const urls = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];
    serp = await startFakeSerp(urls);
    process.env.SERP_SERVICE_URL = serp.url;

    pool = makePool({});
    __setPoolForTesting(pool as never);
    await registerCrawlRoutes(app);

    const res = await app.inject({ method: 'POST', url: '/crawl', payload: { q: 'hello', count: 4 } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { query: string; results: CrawlResult[] };
    assert.equal(body.query, 'hello');
    assert.deepEqual(body.results.map((r) => r.url), urls);
    assert.ok(body.results.every((r) => r.status === 'success'));

    // Sessions reused (fewer distinct sessions than URLs), but every scrape got
    // its own isolated context on whatever browser served it.
    const browsers = allBrowsers(pool);
    const totalContexts = browsers.reduce((n, b) => n + b.allContexts.length, 0);
    assert.equal(totalContexts, urls.length);
    assert.ok(new Set(browsers).size <= urls.length);
    assert.ok(browsers.every((b) => b.allContexts.every((c) => c.closed)));

    // All sessions released, all healthy.
    assert.equal(pool.releaseCount, pool.acquireCount);
    assert.ok(pool.releases.every((r) => r.error === false));
  });

  test('POST /crawl isolates a failing URL: per-item error, only its session recycled', async () => {
    const urls = ['https://ok1.test', 'https://fail.test/x', 'https://ok2.test'];
    serp = await startFakeSerp(urls);
    process.env.SERP_SERVICE_URL = serp.url;

    pool = new MockPool({
      size: 3,
      browserOptions: {
        contextOptions: { pageOptions: { gotoError: undefined } },
      },
    });
    // Make only the fail URL's navigation reject.
    configureFailureForUrl(pool, 'fail.test');
    __setPoolForTesting(pool as never);
    await registerCrawlRoutes(app);

    const res = await app.inject({ method: 'POST', url: '/crawl', payload: { q: 'x', count: 3 } });
    assert.equal(res.statusCode, 200);
    const results = (res.json() as { results: CrawlResult[] }).results;
    assert.deepEqual(results.map((r) => r.status), ['success', 'error', 'success']);
    assert.equal(results[1].url, 'https://fail.test/x');

    const errorReleases = pool.releases.filter((r) => r.error);
    assert.equal(errorReleases.length, 1);
    assert.equal(pool.releaseCount, pool.acquireCount);
  });
});

function allBrowsers(pool: MockPool): MockBrowser[] {
  // MockPool doesn't expose live sessions directly; collect browsers via the
  // release history's session objects is internal, so re-derive from stats is
  // not possible. Instead the mock keeps created browsers reachable through
  // releases; expose a helper on the mock for tests.
  return (pool as unknown as { getBrowsers(): MockBrowser[] }).getBrowsers();
}

/**
 * Configure mock browsers created by this pool so navigation to URLs containing
 * a marker rejects, while other URLs succeed. Implemented by wrapping newContext
 * on every browser the pool hands out.
 */
function configureFailureForUrl(pool: MockPool, marker: string): void {
  const originalAcquire = pool.acquire.bind(pool);
  pool.acquire = async () => {
    const session = await originalAcquire();
    const browser = session.browser as MockBrowser;
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async () => {
      const ctx = await originalNewContext();
      const originalNewPage = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const page = await originalNewPage();
        const originalGoto = page.goto.bind(page);
        page.goto = async (u: string) => {
          if (u.includes(marker)) throw new Error('injected nav failure');
          return originalGoto(u);
        };
        return page;
      };
      return ctx;
    };
    return session;
  };
}
