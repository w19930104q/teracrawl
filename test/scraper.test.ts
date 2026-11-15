import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrapeUrlFast,
  scrapeUrlSlow,
  scrapeUrlWithFallback,
  type CrawlResult,
} from '../src/scraper.js';
import { MockBrowser, MockContext, type MockPageOptions } from './mocks/browser-pool.js';

/**
 * These tests run the REAL scraper functions against mock browsers. The mock
 * implements the Playwright surface the scraper touches (newContext, route,
 * newPage, goto, evaluate, waitForFunction, close), so isolation and cleanup
 * behaviour is verified against production code paths.
 */
describe('scraper context isolation', () => {
  test('fast scraper creates a fresh context per scrape and closes it', async () => {
    const browser = new MockBrowser('s1');

    const r1 = await scrapeUrlFast(browser as never, 'https://one.test');
    const r2 = await scrapeUrlFast(browser as never, 'https://two.test');

    assert.equal(r1.status, 'success');
    assert.equal(r2.status, 'success');
    assert.equal(browser.allContexts.length, 2, 'one context per scrape');
    assert.notEqual(browser.allContexts[0], browser.allContexts[1]);
    assert.ok(browser.allContexts.every((c) => c.closed), 'contexts closed after scrape');
    assert.ok(browser.allContexts.every((c) => c.pages.every((p) => p.closed)));
  });

  test('cookies/storage written in one scrape are invisible to the next', async () => {
    const browser = new MockBrowser('s1');
    const observedCookies: string[][] = [];

    // First scrape simulates a site setting state inside its context.
    const first = await scrapeUrlFast(browser as never, 'https://login.test');
    assert.equal(first.status, 'success');
    const loginContext = browser.allContexts[0];
    loginContext.setCookie('session', 'super-secret');
    assert.equal(loginContext.cookies.get('session'), 'super-secret');

    // Second scrape runs on the same browser session but a new context.
    const secondContextPromise = new Promise<MockContext>((resolve) => {
      const original = browser.newContext.bind(browser);
      browser.newContext = async () => {
        const ctx = await original();
        resolve(ctx);
        return ctx;
      };
    });
    const second = await scrapeUrlFast(browser as never, 'https://other.test');
    const secondContext = await secondContextPromise;

    assert.equal(second.status, 'success');
    assert.equal(secondContext.cookies.size, 0, 'fresh context must not inherit cookies');
    assert.deepEqual(secondContext.storageState, {});
    assert.notEqual(loginContext, secondContext);
    observedCookies.push([...secondContext.cookies.keys()]);
    assert.deepEqual(observedCookies[0], []);
  });

  test('concurrent scrapes on one browser use independent contexts', async () => {
    const browser = new MockBrowser('s1');
    const urls = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];

    const results = await Promise.all(urls.map((u) => scrapeUrlFast(browser as never, u)));

    assert.ok(results.every((r) => r.status === 'success'));
    const contexts = browser.allContexts;
    assert.equal(contexts.length, 4);
    assert.equal(new Set(contexts).size, 4, 'no shared context between concurrent scrapes');
    assert.ok(contexts.every((c) => c.closed));
  });

  test('slow scraper also isolates per URL and tears context down on failure', async () => {
    const browser = new MockBrowser('s1', {
      contextOptions: { pageOptions: { gotoError: new Error('net::ERR_CONNECTION_RESET') } },
    });

    const result = await scrapeUrlSlow(browser as never, 'https://broken.test');

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /ERR_CONNECTION_RESET/);
    assert.equal(browser.allContexts.length, 1);
    assert.ok(browser.allContexts[0].closed);
  });

  test('fallback returns error result without leaking contexts when fast fails', async () => {
    const browser = new MockBrowser('s1', {
      contextOptions: { pageOptions: { gotoError: new Error('boom') } },
    });

    const result = await scrapeUrlWithFallback(browser as never, 'https://fail.test');

    assert.equal(result.status, 'error');
    // Fast context + slow fallback context, both closed.
    assert.ok(browser.allContexts.length >= 1);
    assert.ok(browser.allContexts.every((c) => c.closed));
    assert.ok(browser.allContexts.every((c) => c.pages.every((p) => p.closed)));
  });
});

describe('scraper abort handling', () => {
  test('pre-aborted signal produces an error result and still closes the context', async () => {
    const browser = new MockBrowser('s1');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const result = await scrapeUrlFast(browser as never, 'https://x.test', {
      signal: controller.signal,
    });

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /cancelled/);
    // Aborted before newContext: nothing was created, nothing leaked.
    assert.equal(browser.allContexts.length, 0);
  });

  test('abort during navigation closes the page and context and returns an error', async () => {
    const browser = new MockBrowser('s1', {
      contextOptions: { pageOptions: { blockUntilClosed: true } },
    });
    const controller = new AbortController();

    const pending = scrapeUrlFast(browser as never, 'https://hang.test', {
      signal: controller.signal,
    });
    // Let the scrape reach the blocked goto, then abort.
    setTimeout(() => controller.abort(new Error('deadline reached')), 50);

    const result = await pending;

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /closed|deadline/);
    assert.equal(browser.allContexts.length, 1);
    assert.ok(browser.allContexts[0].closed, 'context closed after abort');
    assert.ok(browser.allContexts[0].pages[0]?.closed, 'page closed after abort');
  });

  test('fallback does not start the slow phase after abort', async () => {
    // First (fast) attempt blocks; abort while it is in flight.
    const browser = new MockBrowser('s1', {
      contextOptions: { pageOptions: { blockUntilClosed: true } },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 50);

    const result = await scrapeUrlWithFallback(browser as never, 'https://hang2.test', {
      signal: controller.signal,
    });

    assert.equal(result.status, 'error');
    // Only the fast context exists — slow fallback must not launch.
    assert.equal(browser.allContexts.length, 1);
    assert.ok(browser.allContexts[0].closed);
  });

  test('abort after fast empty result skips the slow fallback', async () => {
    // Page "succeeds" navigation but extraction yields short content -> empty.
    const shortHtml: MockPageOptions = { html: '<main>short</main>' };
    const browser = new MockBrowser('s1', { contextOptions: { pageOptions: shortHtml } });
    const controller = new AbortController();
    // Abort immediately: the fast scrape's own checks still run, but before the
    // slow phase the signal is already aborted.
    controller.abort(new Error('no time left'));

    const result = await scrapeUrlWithFallback(browser as never, 'https://thin.test', {
      signal: controller.signal,
    });

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /no time left/);
  });
});

describe('scraper result contract', () => {
  test('success result keeps the /scrape field shape', async () => {
    const browser = new MockBrowser('s1');
    const result: CrawlResult = await scrapeUrlFast(browser as never, 'https://shape.test');

    assert.deepEqual(Object.keys(result).sort(), ['markdown', 'status', 'title', 'url']);
    assert.equal(result.url, 'https://shape.test');
    assert.equal(typeof result.title, 'string');
    assert.equal(typeof result.markdown, 'string');
    assert.equal(result.status, 'success');
    assert.equal(result.error, undefined);
  });

  test('error result keeps url and carries an error message', async () => {
    const browser = new MockBrowser('s1', {
      contextOptions: { pageOptions: { gotoError: new Error('dns failure') } },
    });
    const result = await scrapeUrlFast(browser as never, 'https://bad.test');

    assert.equal(result.url, 'https://bad.test');
    assert.equal(result.status, 'error');
    assert.equal(result.title, '');
    assert.equal(result.markdown, '');
    assert.match(result.error ?? '', /dns failure/);
  });
});
