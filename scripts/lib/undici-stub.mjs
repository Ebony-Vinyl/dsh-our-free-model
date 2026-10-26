// Minimal `undici` stand-in for the offline tests that import the channel pack's
// TypeScript sources directly (the shipped `pack.js` bundle inlines the real
// package). `opencode-proxy.ts` only constructs these when an account carries a
// proxy URL, so empty classes are enough to load the module graph.
export class Agent {}
export class Pool {}
export class ProxyAgent {}
export const Dispatcher = class Dispatcher {}
