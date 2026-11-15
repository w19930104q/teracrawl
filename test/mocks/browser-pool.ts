/**
 * Local in-memory mocks for Playwright browser/context/page and for the
 * Browser.cash session pool. They implement exactly the surface area used by
 * src/scraper.ts and src/runner.ts, so the concurrency/isolation guarantees
 * can be verified without any network connection or real browser.
 */

export interface MockPageOptions {
  /** Delay applied to goto() before content becomes available. */
  gotoDelayMs?: number;
  /** When set, goto() rejects with this error (navigation failure). */
  gotoError?: Error;
  /** When true, goto() blocks until the page is closed (abort test). */
  blockUntilClosed?: boolean;
  /** Body HTML returned by evaluate-based extraction. */
  html?: string;
  /** Document title. */
  title?: string;
}

/**
 * Mock Playwright Page. Records the context it belongs to and supports being
 * closed externally (the abort bridge calls page.close() to interrupt goto),
 * in which case any in-flight navigation rejects like a real Playwright page.
 */
export class MockPage {
  readonly context: MockContext;
  closed = false;
  gotoCalls: Array<{ url: string }> = [];
  private readonly options: MockPageOptions;
  private readonly url: string;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(context: MockContext, url: string, options: MockPageOptions = {}) {
    this.context = context;
    this.url = url;
    this.options = options;
  }

  async goto(targetUrl: string): Promise<void> {
    if (this.closed) throw new Error('Target page, context or browser has been closed');
    this.gotoCalls.push({ url: targetUrl });

    if (this.options.blockUntilClosed) {
      await new Promise<void>((_resolve, reject) => {
        this.pendingReject = reject;
      });
      // Race settled by close(); reaching here means the page was closed.
      throw new Error('Target page, context or browser has been closed');
    }

    if (this.options.gotoDelayMs) {
      // Interruptible delay: closing the page (as abortPageOnSignal does on
      // cancellation) rejects the navigation immediately instead of waiting
      // out the full delay, mirroring real Playwright page-close semantics.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingReject = null;
          resolve();
        }, this.options!.gotoDelayMs);
        this.pendingReject = (err: Error) => {
          clearTimeout(timer);
          reject(err);
        };
      });
    }
    if (this.closed) {
      throw new Error('Target page, context or browser has been closed');
    }
    if (this.options.gotoError) {
      throw this.options.gotoError;
    }
  }

  async evaluate(): Promise<{ content: string; title: string }> {
    if (this.closed) throw new Error('Target page, context or browser has been closed');
    return {
      content: this.options.html ?? `<main>${'x'.repeat(500)}</main>`,
      title: this.options.title ?? `title of ${this.url}`,
    };
  }

  async waitForFunction(): Promise<void> {
    if (this.closed) throw new Error('Target page, context or browser has been closed');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingReject = null;
      reject(new Error('Target page, context or browser has been closed'));
    }
  }
}

export interface MockContextOptions {
  pageOptions?: MockPageOptions;
  /** When true, newPage() rejects (simulates a broken browser session). */
  failNewPage?: boolean;
}

/**
 * Mock BrowserContext with its own cookie jar and storage state. Every context
 * is created by MockBrowser.newContext() and gets independent storage, which is
 * what the isolation tests assert on.
 */
export class MockContext {
  readonly browser: MockBrowser;
  closed = false;
  pages: MockPage[] = [];
  cookies = new Map<string, string>();
  storageState: Record<string, string> = {};
  routeHandlers: Array<(route: unknown) => unknown> = [];
  private readonly options: MockContextOptions;

  constructor(browser: MockBrowser, options: MockContextOptions = {}) {
    this.browser = browser;
    this.options = options;
  }

  async route(_pattern: string, handler: (route: unknown) => unknown): Promise<void> {
    this.routeHandlers.push(handler);
  }

  async newPage(): Promise<MockPage> {
    if (this.closed) throw new Error('Context closed');
    if (this.options.failNewPage) throw new Error('Failed to create page (mock)');
    const page = new MockPage(this, `page-${this.pages.length}`, this.options.pageOptions);
    this.pages.push(page);
    return page;
  }

  /** Test helper: pretend the site set a cookie inside this context. */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pages) {
      await page.close();
    }
  }
}

export interface MockBrowserOptions {
  contextOptions?: MockContextOptions;
  connected?: boolean;
}

/**
 * Mock Playwright Browser. newContext() always returns a brand new isolated
 * context; `contexts` lists every context ever created (including closed ones)
 * so tests can assert one-context-per-scrape and that all were closed.
 */
export class MockBrowser {
  readonly sessionId: string;
  allContexts: MockContext[] = [];
  private connected = true;
  private readonly options: MockBrowserOptions;

  constructor(sessionId: string, options: MockBrowserOptions = {}) {
    this.sessionId = sessionId;
    this.options = options;
    this.connected = options.connected ?? true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async newContext(): Promise<MockContext> {
    if (!this.connected) throw new Error('Browser has been disconnected');
    const context = new MockContext(this, this.options.contextOptions);
    this.allContexts.push(context);
    return context;
  }

  contexts(): MockContext[] {
    return this.allContexts;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  /** Test helper: simulate CDP disconnect. */
  disconnect(): void {
    this.connected = false;
  }
}

export interface MockPoolOptions {
  size: number;
  /** Options applied to every browser created by the pool. */
  browserOptions?: MockBrowserOptions | ((sessionId: string) => MockBrowserOptions);
  /** Delay for acquire() when no session is immediately available. */
  acquireDelayMs?: number;
  /**
   * Delay applied to the nth acquire attempt (1-based). Used to simulate slow
   * session creation for a specific caller while others resolve immediately.
   */
  acquireDelayForCall?: Map<number, number>;
}

interface ReleaseRecord {
  sessionId: string;
  error: boolean;
}

/**
 * Mock SessionPool matching the structural SessionPoolLike interface.
 *
 * Sessions are reusable: release(..., false) returns the session to the
 * available bucket, release(..., true) destroys it and creates a replacement
 * (as the real pool's replenish behaviour does). All acquire/release calls are
 * counted so tests can prove every checkout is released exactly once.
 */
export class MockPool {
  readonly size: number;
  private available: Array<{ sessionId: string; browser: MockBrowser }> = [];
  private inUse = new Set<string>();
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private destroyed = new Set<string>();
  private allBrowsers: MockBrowser[] = [];
  private seq = 0;
  private readonly options: MockPoolOptions;

  acquireCount = 0;
  releaseCount = 0;
  releases: ReleaseRecord[] = [];

  constructor(options: MockPoolOptions) {
    this.options = options;
    this.size = options.size;
    for (let i = 0; i < this.size; i++) {
      this.available.push(this.createSession());
    }
  }
  private createSession(): { sessionId: string; browser: MockBrowser } {
    const sessionId = `session-${this.seq++}`;
    const browserOptions = typeof this.options.browserOptions === 'function'
      ? this.options.browserOptions(sessionId)
      : this.options.browserOptions;
    const browser = new MockBrowser(sessionId, browserOptions);
    this.allBrowsers.push(browser);
    return { sessionId, browser };
  }

  private acquireAttempts = 0;

  /**
   * Mirror SessionPool.acquire(): pop an available session when possible,
   * otherwise queue until one is released. Optional configured delays
   * simulate slow on-demand session creation.
   *
   * acquireCount is incremented only when a session is actually checked out,
   * so it stays 1:1 with the release count the runner owes for successful
   * checkouts. Queued callers rejected via abortWaiters() never held a session
   * and therefore are neither counted nor released.
   */
  async acquire(): Promise<{ sessionId: string; browser: MockBrowser }> {
    this.acquireAttempts++;
    const callDelay = this.options.acquireDelayForCall?.get(this.acquireAttempts) ?? 0;

    // Wait until a session is actually free for THIS caller.
    if (this.available.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }

    const delayMs = this.options.acquireDelayMs ?? callDelay;
    if (delayMs) {
      await delay(delayMs);
    }

    const session = this.available.pop();
    if (!session) {
      // Should be unreachable: waiters are only released on release().
      throw new Error('mock pool invariant violated');
    }
    this.acquireCount++;
    this.inUse.add(session.sessionId);
    return session;
  }

  /**
   * Test helper: reject every queued acquire waiter. Used to emulate the
   * runner giving up on a pool whose sessions are never coming back.
   */
  abortWaiters(message = 'mock pool wait aborted'): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) waiter.reject(new Error(message));
  }

  /**
   * Test helper: settle all waiters and mark the pool finished so no acquire
   * promise can keep a test's event loop alive after the test ends.
   */
  close(): void {
    this.abortWaiters('mock pool closed');
  }

  private pumpWaiters(): void {
    if (this.waiters.length > 0 && this.available.length > 0) {
      const entry = this.waiters.shift();
      if (entry) entry.resolve();
    }
  }

  release(session: { sessionId: string; browser: MockBrowser }, error = false): void {
    this.releaseCount++;
    this.releases.push({ sessionId: session.sessionId, error });
    this.inUse.delete(session.sessionId);
    if (error) {
      this.destroyed.add(session.sessionId);
      // Replenish: replacement gets a new id and is available for later jobs.
      this.available.push(this.createSession());
    } else if (!this.destroyed.has(session.sessionId)) {
      this.available.push(session);
    }
    this.pumpWaiters();
  }

  stats(): { maxSize: number; available: number; inUse: number; waiting: number; total: number; creating: number } {
    return {
      maxSize: this.size,
      available: this.available.length,
      inUse: this.inUse.size,
      waiting: this.waiters.length,
      total: this.available.length + this.inUse.size,
      creating: 0,
    };
  }

  /** Test helpers. */
  isDestroyed(sessionId: string): boolean {
    return this.destroyed.has(sessionId);
  }

  getDestroyedIds(): string[] {
    return [...this.destroyed];
  }

  /** Every browser created by this pool (including replacements). */
  getBrowsers(): MockBrowser[] {
    return [...this.allBrowsers];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
