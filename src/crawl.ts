import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { loadEnvNumber } from './env.js';
import { runSerpQuery } from './serp.js';
import { getPool } from './pool.js';
import { CrawlResult, scrapeUrlWithFallback, isPdfUrl, isPdfSupportEnabled } from './scraper.js';
import { runCrawlWithPool, acquireWithDeadline } from './runner.js';
import { combineSignals, isAbortError, scheduleTimeout } from './abort.js';
import { createPerfLogger } from './perf.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

/**
 * Maximum number of scrapes run in parallel. 0 (default) means "match the
 * pool size", which is the natural ceiling since each worker needs a session.
 */
const CRAWL_CONCURRENCY = loadEnvNumber('CRAWL_CONCURRENCY', 0);

/** Resolve tunable timeouts at request time so tests can override the env. */
function crawlTotalTimeoutMs(): number {
  return loadEnvNumber('CRAWL_TOTAL_TIMEOUT_MS', 60_000);
}
function scrapeTimeoutMs(): number {
  return loadEnvNumber('SCRAPE_TIMEOUT_MS', 30_000);
}

interface CrawlRequestBody {
  q?: string;
  count?: number;
}

interface ScrapeRequestBody {
  url?: string;
}

export async function registerCrawlRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /crawl
   * Search Google and scrape top results to Markdown
   *
   * Each URL is scraped inside its own isolated BrowserContext on a pooled
   * browser session. Sessions are reused while healthy; only a session whose
   * own scrape failed is recycled. Results come back in SERP order with
   * per-item errors, and the whole batch is bounded by a total timeout.
   */
  app.post('/crawl', async (req: FastifyRequest, reply: FastifyReply) => {
    const perf = createPerfLogger();
    const body = req.body as CrawlRequestBody;
    const query = (body?.q ?? '').toString().trim();
    const count = Math.max(1, Math.min(20, Number(body?.count ?? 3)));

    perf.event('Request received', { query, count });

    if (!query) {
      return reply.status(400).send({ error: 'q_required' });
    }

    // External cancellation: stop launching/racing work once the HTTP client
    // goes away. In-flight page operations are interrupted via the signal too.
    const clientAbort = new AbortController();
    const onClientClose = () => clientAbort.abort(new Error('client disconnected'));
    req.raw.once('close', onClientClose);

    try {
      // 1. Get URLs from SERP service
      perf.beginStep('SERP query');
      const serpResults = await runSerpQuery(query, count);
      perf.endStep('SERP query', { resultsCount: serpResults.length });

      // Filter to valid HTTP URLs
      // PDFs are only included if DATALAB_API_KEY is configured
      const pdfSupport = isPdfSupportEnabled();
      const urls = serpResults
        .map((r) => r.url)
        .filter((url): url is string => typeof url === 'string' && url.startsWith('http'))
        .filter((url) => pdfSupport || !isPdfUrl(url));

      if (urls.length === 0) {
        perf.event('No URLs found from SERP');
        perf.summary();
        return reply.send({ query, results: [] });
      }

      perf.event('URLs to crawl', { count: urls.length, urls });

      // 2. Scrape URLs using browser pool
      const pool = getPool();
      const concurrency = CRAWL_CONCURRENCY > 0
        ? CRAWL_CONCURRENCY
        : Math.max(1, pool.stats().maxSize);
      const totalTimeoutMs = crawlTotalTimeoutMs();

      if (DEBUG_LOG) {
        console.log(`[crawl] Scraping ${urls.length} URLs (concurrency=${concurrency}, timeout=${totalTimeoutMs}ms)`);
      }

      perf.beginStep('Scrape all URLs');

      const { results, cancelled, timedOut } = await runCrawlWithPool({
        jobs: urls.map((url, index) => ({ url, index })),
        pool,
        concurrency,
        timeoutMs: totalTimeoutMs,
        externalSignal: clientAbort.signal,
        scrape: (browser, url, signal) =>
          scrapeUrlWithFallback(browser as Browser, url, { signal }),
      });

      // Summarize results
      const successCount = results.filter((r) => r.status === 'success').length;
      const emptyCount = results.filter((r) => r.status === 'empty').length;
      const errorCount = results.filter((r) => r.status === 'error').length;

      perf.endStep('Scrape all URLs');
      perf.event('Crawl complete', {
        total: urls.length,
        success: successCount,
        empty: emptyCount,
        errors: errorCount,
        cancelled,
        timedOut,
      });
      perf.summary();

      if (DEBUG_LOG) {
        console.log(`[crawl] Complete: ${successCount}/${urls.length} with content`);
      }

      // Client already gone: nothing to send, and the work has been unwound.
      if (reply.raw.writableEnded || clientAbort.signal.aborted) {
        return reply;
      }

      return reply.send({ query, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      perf.error('Crawl', message);
      perf.summary();

      if (DEBUG_LOG) {
        console.error('[crawl] error:', err);
      }

      if (reply.raw.writableEnded) return reply;
      return reply.status(500).send({
        error: 'crawl_failed',
        message,
      });
    } finally {
      req.raw.removeListener('close', onClientClose);
    }
  });

  /**
   * POST /scrape
   * Scrape a single URL to Markdown (for testing)
   *
   * Response shape is unchanged: { url, title, markdown, status, error? }.
   */
  app.post('/scrape', async (req: FastifyRequest, reply: FastifyReply) => {
    const perf = createPerfLogger();
    const body = req.body as ScrapeRequestBody;
    const url = (body?.url ?? '').toString().trim();

    perf.event('Scrape request', { url });

    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.status(400).send({ error: 'valid_url_required' });
    }

    // Reject PDF URLs if DATALAB_API_KEY is not configured
    if (isPdfUrl(url) && !isPdfSupportEnabled()) {
      perf.event('PDF rejected - no API key');
      perf.summary();
      return reply.status(400).send({
        error: 'pdf_not_supported',
        message: 'PDF URLs require DATALAB_API_KEY to be configured',
      });
    }

    // Bounded wait for a session + bounded scrape; client disconnect cancels.
    const clientAbort = new AbortController();
    const onClientClose = () => clientAbort.abort(new Error('client disconnected'));
    req.raw.once('close', onClientClose);

    const pool = getPool();
    let session: Awaited<ReturnType<typeof pool.acquire>> | null = null;
    let released = false;

    const releaseOnce = (hadError: boolean) => {
      if (session && !released) {
        released = true;
        pool.release(session, hadError);
      }
    };

    // Overall deadline covers both the (potentially queued) acquire and the
    // scrape itself, so an exhausted pool can never hang this request forever.
    const deadline = new AbortController();
    const cancelTimeout = scheduleTimeout(deadline, scrapeTimeoutMs(), 'scrape');
    const { signal, cleanup } = combineSignals(clientAbort.signal, deadline.signal);

    try {
      perf.beginStep('Acquire session');
      session = await acquireWithDeadline(pool, signal);
      perf.endStep('Acquire session', { sessionId: session.sessionId });

      perf.beginStep('Scrape URL');
      const result = await scrapeUrlWithFallback(session.browser as Browser, url, { signal });
      perf.endStep('Scrape URL', { status: result.status });
      perf.summary();

      // Recycling reflects THIS scrape's own outcome, nothing else.
      releaseOnce(result.status === 'error');
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      perf.error('Scrape', message);
      perf.summary();

      if (DEBUG_LOG) {
        console.error('[scrape] error:', err);
      }

      releaseOnce(true);

      if (reply.raw.writableEnded) return reply;
      // Only deadline/disconnect failures are 504; a scrape that ran and
      // failed normally returns its result body with 200 (handled above).
      const isDeadline = isAbortError(err);
      return reply.status(isDeadline ? 504 : 500).send({
        error: 'scrape_failed',
        message,
      });
    } finally {
      cancelTimeout();
      cleanup();
      req.raw.removeListener('close', onClientClose);
    }
  });
}
