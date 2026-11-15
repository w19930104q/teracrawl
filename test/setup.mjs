/**
 * Test preload: set environment variables that production modules read at
 * import time, before any test module is loaded. Loaded via `node --import`.
 * Kept as plain ESM (.mjs) so it runs before the TypeScript loader is needed.
 */
process.env.BROWSER_API_KEY ??= 'test-api-key';
