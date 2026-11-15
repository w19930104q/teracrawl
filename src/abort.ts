/**
 * Cancellation helpers built around AbortController/AbortSignal.
 *
 * The pool from @browsercash/pool has no native signal support, so these
 * helpers let us race pool/scrape work against an external cancellation
 * signal or an overall deadline without losing resources.
 */

/**
 * Error thrown when work is cancelled by an AbortSignal or an overall timeout.
 */
export class AbortError extends Error {
  readonly code = 'ABORT_ERR';
  readonly timedOut: boolean;

  constructor(message: string, timedOut = false) {
    super(message);
    this.name = 'AbortError';
    this.timedOut = timedOut;
  }
}

/**
 * Return true when the signal is already aborted.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR');
}

/**
 * Combine multiple signals into one controller. The returned controller is
 * aborted (with the same reason) as soon as any input signal aborts.
 *
 * Works on Node >= 18 without relying on AbortSignal.any (added in 20.3).
 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

/**
 * Race a promise against an AbortSignal. Rejects with an AbortError as soon as
 * the signal aborts; otherwise resolves/rejects with the underlying promise.
 *
 * Note: the underlying work is NOT cancelled by this helper — callers remain
 * responsible for cleaning up (e.g. closing pages, releasing sessions) when
 * the race loses. The underlying promise is given a no-op handler so a late
 * rejection cannot surface as an unhandled rejection.
 */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal, label = 'operation'): Promise<T> {
  if (signal.aborted) {
    // Attach a no-op handler in case the caller ignores the rejection later.
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal, label));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(abortReason(signal, label));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function abortReason(signal: AbortSignal, label: string): AbortError {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason as AbortError;
  }
  if (reason instanceof Error) {
    return new AbortError(`${label} aborted: ${reason.message}`);
  }
  return new AbortError(`${label} aborted`);
}

/**
 * Reject after `timeoutMs` with a timeout AbortError, unless the controller is
 * aborted earlier (e.g. by external cancellation). The timer is kept referenced
 * (intentionally NOT unref'd): the deadline itself must keep the event loop
 * alive while work is being awaited, otherwise the process could observe an
 * empty loop and exit before the timeout ever fires. The returned cancel
 * function clears the timer on normal completion.
 */
export function scheduleTimeout(controller: AbortController, timeoutMs: number, label: string): () => void {
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new AbortError(`${label} timed out after ${timeoutMs}ms`, true));
    }
  }, timeoutMs);
  return () => clearTimeout(timer);
}
