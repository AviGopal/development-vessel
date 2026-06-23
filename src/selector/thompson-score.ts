/**
 * Thompson sampling score for P(success | activity, shape).
 *
 * Uses a Beta(alpha, beta) conjugate prior.
 * When no observations exist for a given key, falls back to the
 * non-informative Beta(1, 1) prior, which draws uniformly from [0,1]
 * and produces a usable (non-null) score for every candidate.
 */

export interface BetaParams {
  alpha: number;
  beta: number;
}

/** Stored per (activity, shape) pair. */
export interface ThompsonRecord {
  successes: number;
  trials: number;
}

/** Beta(1,1) non-informative prior — used when no data exists. */
const DEFAULT_PRIOR: BetaParams = { alpha: 1, beta: 1 };

/**
 * Convert a ThompsonRecord to Beta parameters.
 * alpha = successes + prior.alpha
 * beta  = (trials - successes) + prior.beta
 */
export function recordToParams(
  record: ThompsonRecord | null | undefined,
  prior: BetaParams = DEFAULT_PRIOR
): BetaParams {
  if (!record || record.trials <= 0) {
    return { ...prior };
  }
  const successes = Math.max(0, record.successes);
  const failures = Math.max(0, record.trials - successes);
  return {
    alpha: successes + prior.alpha,
    beta: failures + prior.beta,
  };
}

/**
 * Draw a Thompson sample from Beta(alpha, beta) using the
 * Johnk method (no external dependencies, pure TS).
 *
 * Returns a value in (0, 1) — never null.
 */
export function sampleBeta(alpha: number, beta: number): number {
  // Guard: clamp to valid range
  const a = Math.max(alpha, 1e-6);
  const b = Math.max(beta, 1e-6);

  // Special case: uniform
  if (a === 1 && b === 1) {
    return Math.random();
  }

  // Johnk's method: works well for a,b >= 1
  // For robustness we use the gamma-ratio method via log-transform.
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  const total = x + y;
  if (total <= 0) return 0.5; // degenerate guard
  return x / total;
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia-Tsang method.
 * shape must be > 0.
 */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    // Boost via: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
  return d; // fallback
}

/** Standard normal sample via Box-Muller. */
function randn(): number {
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random() || 1e-10;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Compute a Thompson score for a candidate given its observation record.
 *
 * NEVER returns null — falls back to Beta(1,1) prior when record is absent.
 */
export function thompsonScore(
  record: ThompsonRecord | null | undefined,
  prior: BetaParams = DEFAULT_PRIOR
): number {
  const params = recordToParams(record, prior);
  return sampleBeta(params.alpha, params.beta);
}
