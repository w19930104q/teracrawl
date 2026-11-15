import type { Browser, Page, BrowserContext } from 'playwright-core';
import { loadEnvNumber } from './env.js';
import { parseHtmlToMarkdown } from './markdown.js';
import { isPdfUrl, convertPdfToMarkdown, isPdfSupportEnabled } from './pdf.js';
import { AbortError, isAbortError, raceWithSignal } from './abort.js';

// Re-export PDF utilities for direct access
export { isPdfUrl, convertPdfToMarkdown, isPdfSupportEnabled } from './pdf.js';
export type { PdfConversionResult } from './pdf.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// Configuration
const MIN_CONTENT_LENGTH = loadEnvNumber('CRAWL_MIN_CONTENT_LENGTH', 200);
const NAVIGATION_TIMEOUT_MS = loadEnvNumber('CRAWL_NAVIGATION_TIMEOUT_MS', 10000);
const SLOW_TIMEOUT_MS = loadEnvNumber('CRAWL_SLOW_TIMEOUT_MS', 20000);

// Content selectors in priority order (semantic elements first)
const CONTENT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '#content',
  '.content',
  '#main',
  '.main',
];

export interface CrawlResult {
  url: string;
  title: string;
  markdown: string;
  status: 'success' | 'empty' | 'error';
  error?: string;
}

export interface ScrapeOptions {
  /** Cancellation/deadline signal for the whole scrape (fast + slow fallback). */
  signal?: AbortSignal;
}

/**
 * Log scraper performance with color-coded duration
 */
function logPerf(step: string, url: string, startTime: number, details?: Record<string, unknown>): void {
  const duration = performance.now() - startTime;
  const color = duration < 1000 ? '\x1b[32m' : duration < 5000 ? '\x1b[33m' : '\x1b[31m';
  const urlShort = url.length > 50 ? url.slice(0, 50) + '...' : url;
  const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
  console.log(`\x1b[35m[SCRAPER]\x1b[0m ${step.padEnd(20)} | ${color}${duration.toFixed(0).padStart(5)}ms\x1b[0m | ${urlShort}${detailsStr}`);
}

/**
 * Check if markdown content meets minimum length threshold
 */
function isValidContent(markdown: string): boolean {
  const cleaned = markdown.replace(/\s+/g, ' ').trim();
  return cleaned.length >= MIN_CONTENT_LENGTH;
}

/**
 * Extract main content and title from page in a single evaluate call
 */
async function extractContentAndTitle(page: Page): Promise<{ content: string; title: string }> {
  return page.evaluate((selectors: string[]) => {
    const title = document.title || '';
    if (!document.body) return { content: '', title };

    // Try semantic selectors first
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && (el.textContent || '').trim().length > 200) {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, iframe, svg').forEach((e) => e.remove());
        return { content: clone.innerHTML, title };
      }
    }

    // Fall back to cleaned body
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(
      'script, style, noscript, iframe, svg, header, footer, nav, aside, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"]'
    ).forEach((el) => el.remove());

    return { content: clone.innerHTML, title };
  }, CONTENT_SELECTORS);
}

/**
 * Configure route blocking on a freshly created context.
 *
 * Every scrape now gets its own BrowserContext, so there is nothing to cache
 * the routing on — the handler is simply attached once per context.
 */
async function ensureRouteBlocking(context: BrowserContext, blockStylesheets: boolean): Promise<void> {
  const blockedTypes = blockStylesheets
    ? ['image', 'font', 'stylesheet', 'media']
    : ['image', 'font', 'media'];

  await context.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (blockedTypes.includes(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });
}

/**
 * Safely close a page, logging any errors
 */
async function closePage(page: Page | null, url: string): Promise<void> {
  if (!page) return;
  try {
    await page.close();
  } catch (err) {
    if (DEBUG_LOG) {
      console.warn(`[scraper] Failed to close page for ${url}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Safely close a context, logging any errors
 */
async function closeContext(context: BrowserContext | null, url: string): Promise<void> {
  if (!context) return;
  try {
    await context.close();
  } catch (err) {
    if (DEBUG_LOG) {
      console.warn(`[scraper] Failed to close context for ${url}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Build an error result for a URL. Cancellation/timeout errors keep their
 * message so callers can distinguish them from ordinary scrape failures.
 */
function errorResult(url: string, err: unknown): CrawlResult {
  const message = err instanceof Error ? err.message : String(err);
  return { url, title: '', markdown: '', status: 'error', error: message };
}

/**
 * Throw an AbortError carrying the signal's own reason (if it is an Error) so
 * cancellation messages from callers — e.g. "client disconnected" — survive.
 */
function throwIfAborted(signal: AbortSignal | undefined, phase: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw new AbortError(reason.message);
  }
  throw new AbortError(`${phase} aborted`);
}

/**
 * Result-shaped counterpart of throwIfAborted for phases that return results
 * instead of throwing (the fallback orchestrator).
 */
function abortResult(url: string, signal: AbortSignal, phase: string): CrawlResult {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : `${phase} aborted`;
  return { url, title: '', markdown: '', status: 'error', error: message };
}

/**
 * Bridge an AbortSignal to page lifetime: when the signal aborts, the page is
 * closed, which rejects any in-flight Playwright operation (goto, evaluate,
 * waitForFunction...) instead of waiting for its own navigation timeout.
 *
 * Returns a detach function for normal completion; all cleanup errors are
 * swallowed because the finally block closes the page/context anyway.
 */
function abortPageOnSignal(page: Page, signal: AbortSignal | undefined, url: string): () => void {
  if (!signal) return () => undefined;

  if (signal.aborted) {
    void page.close().catch(() => undefined);
    return () => undefined;
  }

  const onAbort = () => {
    if (DEBUG_LOG) {
      console.warn(`[scraper] Abort signal received, closing page for ${url}`);
    }
    void page.close().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Fast scraper - optimized for static/SSR pages
 *
 * - Always creates a fresh, isolated BrowserContext (no shared cookies/storage)
 * - Blocks heavy assets (images, fonts, stylesheets)
 * - Waits only for 'domcontentloaded' then extracts immediately
 * - The context (and its page) is always closed, even on cancellation
 */
export async function scrapeUrlFast(
  browser: Browser,
  url: string,
  options: ScrapeOptions = {}
): Promise<CrawlResult> {
  const { signal } = options;
  const scrapeStart = performance.now();
  console.log(`\x1b[35m[SCRAPER]\x1b[0m Starting scrape: ${url}`);

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let detachAbort: (() => void) | null = null;

  try {
    throwIfAborted(signal, 'scrape');

    const contextStart = performance.now();

    // Fresh context per scrape: cookies, localStorage and sessionStorage are
    // scoped to this context and destroyed with it, so concurrent/sequential
    // scrapes on the same browser session can never pollute each other.
    context = await browser.newContext();
    await ensureRouteBlocking(context, true);
    page = await context.newPage();
    detachAbort = abortPageOnSignal(page, signal, url);
    logPerf('Page created', url, contextStart);

    // Navigate and extract content
    const navStart = performance.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    logPerf('Navigation done', url, navStart);

    const extractStart = performance.now();
    const { content, title } = await extractContentAndTitle(page);
    const markdown = parseHtmlToMarkdown(content);
    logPerf('Content extracted', url, extractStart, { titleLen: title.length, mdLen: markdown.length });

    const status = isValidContent(markdown) ? 'success' : 'empty';
    logPerf('FAST TOTAL', url, scrapeStart, { status });

    if (status === 'success') {
      return { url, title, markdown, status };
    }
    return { url, title: '', markdown: '', status: 'empty' };
  } catch (err) {
    if (isAbortError(err)) {
      logPerf('FAST ABORTED', url, scrapeStart, { error: (err as Error).message });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logPerf('FAST ERROR', url, scrapeStart, { error: message });

      if (DEBUG_LOG) {
        console.error(`[scraper:fast] Failed ${url}:`, message);
      }
    }
    return errorResult(url, err);
  } finally {
    detachAbort?.();
    await closePage(page, url);
    await closeContext(context, url);
  }
}

/**
 * Slow scraper - fallback for SPAs and dynamic content
 *
 * - Creates a fresh isolated context per scrape
 * - Waits for full page load
 * - Waits for content to render
 * - Less aggressive asset blocking (allows stylesheets)
 */
export async function scrapeUrlSlow(
  browser: Browser,
  url: string,
  options: ScrapeOptions = {}
): Promise<CrawlResult> {
  const { signal } = options;
  const scrapeStart = performance.now();
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let detachAbort: (() => void) | null = null;

  try {
    throwIfAborted(signal, 'scrape');

    const contextStart = performance.now();
    context = await browser.newContext();
    await ensureRouteBlocking(context, false);
    page = await context.newPage();
    detachAbort = abortPageOnSignal(page, signal, url);
    logPerf('Context created', url, contextStart);

    // Navigate with full load
    const navStart = performance.now();
    await page.goto(url, { waitUntil: 'load', timeout: SLOW_TIMEOUT_MS });
    logPerf('Navigation done', url, navStart);

    // Wait for content to render. An abort during the wait closes the page
    // (see abortPageOnSignal), which rejects this call — rethrow in that case.
    try {
      await page.waitForFunction(
        (minLen: number) => {
          const text = document.body?.innerText || '';
          return text.replace(/\s+/g, '').length > minLen;
        },
        MIN_CONTENT_LENGTH,
        { timeout: 10000 }
      );
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        throw new AbortError('scrape aborted while waiting for content');
      }
      // Content may still be usable even if the wait times out
      if (DEBUG_LOG) {
        console.warn(`[scraper:slow] Content wait timed out for ${url}`);
      }
    }

    if (signal?.aborted) throwIfAborted(signal, 'content extraction');

    const extractStart = performance.now();
    const { content, title } = await extractContentAndTitle(page);
    const markdown = parseHtmlToMarkdown(content);
    logPerf('Content extracted', url, extractStart, { titleLen: title.length, mdLen: markdown.length });

    const status = isValidContent(markdown) ? 'success' : 'empty';
    logPerf('SLOW TOTAL', url, scrapeStart, { status });

    if (status === 'success') {
      return { url, title, markdown, status };
    }
    return { url, title, markdown, status: 'empty' };
  } catch (err) {
    if (isAbortError(err)) {
      logPerf('SLOW ABORTED', url, scrapeStart, { error: (err as Error).message });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logPerf('SLOW ERROR', url, scrapeStart, { error: message });

      if (DEBUG_LOG) {
        console.error(`[scraper:slow] Failed ${url}:`, message);
      }
    }
    return errorResult(url, err);
  } finally {
    detachAbort?.();
    await closePage(page, url);
    await closeContext(context, url);
  }
}

/**
 * Scrape with automatic fallback
 *
 * Checks if URL is a PDF and uses Datalab Marker API for conversion (if API key is configured).
 * For regular URLs, tries fast scraper first, falls back to slow scraper if fast returns empty/error.
 *
 * When `options.signal` aborts, no new phase is started and the in-flight
 * scrape returns an error result whose `error` describes the cancellation.
 */
export async function scrapeUrlWithFallback(
  browser: Browser,
  url: string,
  options: ScrapeOptions = {}
): Promise<CrawlResult> {
  const { signal } = options;
  const startTime = performance.now();

  // Handle PDF URLs with Datalab Marker API
  if (isPdfUrl(url)) {
    if (!isPdfSupportEnabled()) {
      logPerf('PDF REJECTED', url, startTime, { reason: 'no_api_key' });
      return {
        url,
        title: '',
        markdown: '',
        status: 'error',
        error: 'PDF URLs require DATALAB_API_KEY to be configured',
      };
    }
    if (signal?.aborted) {
      return abortResult(url, signal, 'PDF conversion');
    }
    console.log(`\x1b[36m[PDF]\x1b[0m Detected PDF URL, using Marker API: ${url}`);
    const pdfResult = signal
      ? await raceWithSignal(convertPdfToMarkdown(url), signal, 'pdf conversion')
      : await convertPdfToMarkdown(url);
    logPerf('PDF CONVERSION', url, startTime, { status: pdfResult.status });
    return pdfResult;
  }

  if (signal?.aborted) {
    return abortResult(url, signal, 'fast phase');
  }

  const fast = await scrapeUrlFast(browser, url, { signal });
  if (fast.status === 'success') {
    logPerf('WITH FALLBACK', url, startTime, { method: 'fast', status: 'success' });
    return fast;
  }

  // Do not burn a second browser attempt after cancellation/timeout.
  if (signal?.aborted) {
    return abortResult(url, signal, 'slow fallback');
  }

  // Try slow scraper as fallback
  console.log(`\x1b[35m[SCRAPER]\x1b[0m Fast scrape incomplete, trying slow method: ${url}`);
  const slow = await scrapeUrlSlow(browser, url, { signal });
  logPerf('WITH FALLBACK', url, startTime, { method: 'slow', status: slow.status });

  return slow;
}
