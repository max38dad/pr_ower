// ── Load Balancer ──
// Round-robin distribution + optional consistent-hash session affinity.
// All operations are O(1) and safe under concurrent access.

import { config } from './config.js';

/**
 * Simple FNV-1a hash for affinity keys.
 * Returns a 32-bit unsigned integer.
 */
function fnv1a(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Round-robin selector using an atomic-ish counter.
 * Safe under concurrent access because JS is single-threaded.
 */
export class LoadBalancer {
  constructor() {
    this.backends = config.backends;
    this.counter = 0;
    this.ready = this.backends.length > 0;
  }

  /**
   * Pick the next backend using round-robin.
   * Overflow-safe counter reset.
   */
  roundRobin() {
    if (this.backends.length === 0) return null;
    const idx = this.counter % this.backends.length;
    this.counter = (this.counter + 1) >>> 0; // 32-bit unsigned overflow-safe
    return this.backends[idx];
  }

  /**
   * Pick a backend based on affinity key (consistent hashing).
   * Same key → same backend (unless backends list changes).
   */
  affinity(key) {
    if (this.backends.length === 0) return null;
    const hash = fnv1a(key);
    const idx = hash % this.backends.length;
    return this.backends[idx];
  }

  /**
   * Smart pick: uses affinity if key provided, otherwise round-robin.
   * @param {string|null} affinityKey
   * @returns {string|null} backend URL
   */
  pick(affinityKey = null) {
    if (!this.ready || this.backends.length === 0) return null;
    if (affinityKey) {
      return this.affinity(affinityKey);
    }
    return this.roundRobin();
  }

  /**
   * Update backends at runtime (e.g., from service discovery).
   */
  updateBackends(backends) {
    this.backends = backends;
    this.ready = backends.length > 0;
    this.counter = 0;
  }

  getBackendCount() {
    return this.backends.length;
  }
}

export default LoadBalancer;
