'use strict';

// Pure deterministic visual-order algorithm. No DB/models/routes.
// Used only by the seller ordering catalogue presentation layer.

const ALGORITHM_VERSION = 1;
const CACHE_TTL_SEC = 8 * 24 * 60 * 60;
const SKETCH_DIM = 384;
const EXACT_SMALL_SET_LIMIT = 180;
const MATRIX_LIMIT = 2400;
const TWO_OPT_PASSES = 4;
const EPS = 1e-7;

function stableFallbackCompare(a, b) {
  const oa = Number(a?.orderNumber ?? Number.MAX_SAFE_INTEGER);
  const ob = Number(b?.orderNumber ?? Number.MAX_SAFE_INTEGER);
  if (oa !== ob) return oa - ob;
  const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (ta !== tb) return tb - ta;
  return String(a?.id ?? a?._id ?? '').localeCompare(String(b?.id ?? b?._id ?? ''));
}

function normalizeDense(values) {
  const out = new Float32Array(values.length);
  let norm2 = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    const safe = Number.isFinite(v) ? v : 0;
    out[i] = safe;
    norm2 += safe * safe;
  }
  const norm = Math.sqrt(norm2);
  if (!norm) return null;
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

// Deterministic feature-hashing projection. It preserves cosine neighbourhoods
// well enough for a ~1k-product catalogue while avoiding a multi-second 3072-d
// O(N²) request. Small sets still use the exact full vector below.
function sketchVector(values, targetDim = SKETCH_DIM) {
  const out = new Float32Array(targetDim);
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    const hash = Math.imul((i + 1) >>> 0, 0x9e3779b1) >>> 0;
    const bucket = hash % targetDim;
    const signHash = Math.imul((i + 1) >>> 0, 0x85ebca6b) >>> 0;
    out[bucket] += (signHash & 0x80000000) ? -v : v;
  }
  return normalizeDense(out);
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function chooseCompatibleVectorGroup(entries) {
  // Dimension mismatch is always incompatible. Legacy rows can have an empty
  // model name after the old vector migration; treat that empty name as
  // "unknown but compatible with the dominant named model of the same dim"
  // instead of dumping the whole legacy catalogue into the fallback tail.
  const byDim = new Map();
  for (const entry of entries) {
    const vector = entry?.vector;
    if (!Array.isArray(vector) || vector.length < 2) continue;
    const dim = Number(entry.dim) || vector.length;
    if (dim !== vector.length) continue;
    if (!byDim.has(dim)) byDim.set(dim, []);
    byDim.get(dim).push(entry);
  }
  const dimGroups = [...byDim.entries()].sort((a, b) => {
    if (a[1].length !== b[1].length) return b[1].length - a[1].length;
    return a[0] - b[0];
  });
  if (!dimGroups.length) return [null, []];

  const [dim, sameDim] = dimGroups[0];
  const modelCounts = new Map();
  for (const entry of sameDim) {
    const model = String(entry.model || '').trim();
    if (!model) continue;
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
  }
  const dominantModel = [...modelCounts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  })[0]?.[0] || '';

  const compatible = sameDim.filter((entry) => {
    const model = String(entry.model || '').trim();
    return !dominantModel || !model || model === dominantModel;
  });
  return [`${dominantModel || 'legacy-unknown'}::${dim}`, compatible];
}

function buildDistanceAccessor(vectors) {
  const n = vectors.length;
  if (n <= MATRIX_LIMIT) {
    const matrix = new Float32Array(n * n);
    for (let i = 0; i < n; i += 1) {
      const a = vectors[i];
      const base = i * n;
      for (let j = i + 1; j < n; j += 1) {
        const distance = Math.max(0, 1 - dot(a, vectors[j]));
        matrix[base + j] = distance;
        matrix[j * n + i] = distance;
      }
    }
    return (i, j) => matrix[i * n + j];
  }
  return (i, j) => Math.max(0, 1 - dot(vectors[i], vectors[j]));
}

function chooseDeterministicEdgeStart(vectors, entries) {
  if (vectors.length <= 1) return 0;
  const dim = vectors[0].length;
  const centroid = new Float32Array(dim);
  for (const vector of vectors) {
    for (let d = 0; d < dim; d += 1) centroid[d] += vector[d];
  }
  const normalizedCentroid = normalizeDense(centroid);
  if (!normalizedCentroid) {
    let best = 0;
    for (let i = 1; i < entries.length; i += 1) {
      if (String(entries[i].id).localeCompare(String(entries[best].id)) < 0) best = i;
    }
    return best;
  }

  // Start at a semantic edge (least aligned with the catalogue centroid). This
  // makes the open path less likely to begin in the middle of a dense product family.
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < vectors.length; i += 1) {
    const score = dot(vectors[i], normalizedCentroid);
    if (score < bestScore - EPS) {
      best = i;
      bestScore = score;
    } else if (Math.abs(score - bestScore) <= EPS
      && String(entries[i].id).localeCompare(String(entries[best].id)) < 0) {
      best = i;
    }
  }
  return best;
}

function buildGreedyRoute(vectors, entries, distance) {
  const n = vectors.length;
  if (n <= 1) return n ? [0] : [];
  const route = new Array(n);
  const used = new Uint8Array(n);
  let current = chooseDeterministicEdgeStart(vectors, entries);
  route[0] = current;
  used[current] = 1;

  for (let pos = 1; pos < n; pos += 1) {
    let best = -1;
    let bestDistance = Infinity;
    for (let candidate = 0; candidate < n; candidate += 1) {
      if (used[candidate]) continue;
      const d = distance(current, candidate);
      if (d < bestDistance - EPS) {
        best = candidate;
        bestDistance = d;
      } else if (Math.abs(d - bestDistance) <= EPS && best !== -1
        && String(entries[candidate].id).localeCompare(String(entries[best].id)) < 0) {
        best = candidate;
      }
    }
    route[pos] = best;
    used[best] = 1;
    current = best;
  }
  return route;
}

function reverseRange(route, from, to) {
  while (from < to) {
    const tmp = route[from];
    route[from] = route[to];
    route[to] = tmp;
    from += 1;
    to -= 1;
  }
}

function optimizeTwoOpt(route, distance, maxPasses = TWO_OPT_PASSES) {
  const n = route.length;
  if (n < 4) return route;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let i = 0; i < n - 1; i += 1) {
      const a = i > 0 ? route[i - 1] : -1;
      const b = route[i];
      for (let k = i + 1; k < n; k += 1) {
        const c = route[k];
        const d = k + 1 < n ? route[k + 1] : -1;

        const before = (a >= 0 ? distance(a, b) : 0) + (d >= 0 ? distance(c, d) : 0);
        const after = (a >= 0 ? distance(a, c) : 0) + (d >= 0 ? distance(b, d) : 0);
        if (after + EPS < before) {
          reverseRange(route, i, k);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return route;
}

function pathDistance(route, distance) {
  let total = 0;
  for (let i = 1; i < route.length; i += 1) total += distance(route[i - 1], route[i]);
  return total;
}

/**
 * Pure algorithm: returns ids only. No DB writes, no categories/clusters.
 */
function buildVisualSequence(entries) {
  const stable = [...entries].sort(stableFallbackCompare);
  if (stable.length <= 1) {
    return {
      ids: stable.map((e) => String(e.id)),
      meta: { algorithmVersion: ALGORITHM_VERSION, withEmbedding: stable.length, withoutEmbedding: 0 },
    };
  }

  const [groupKey, compatible] = chooseCompatibleVectorGroup(stable);
  const compatibleIds = new Set(compatible.map((e) => String(e.id)));
  const fallback = stable.filter((e) => !compatibleIds.has(String(e.id)));

  if (compatible.length <= 1) {
    return {
      ids: [...compatible, ...fallback].map((e) => String(e.id)),
      meta: {
        algorithmVersion: ALGORITHM_VERSION,
        vectorGroup: groupKey,
        withEmbedding: compatible.length,
        withoutEmbedding: fallback.length,
      },
    };
  }

  const useExact = compatible.length <= EXACT_SMALL_SET_LIMIT;
  const vectors = [];
  const vectorEntries = [];
  const normalizationFallback = [];
  for (const entry of compatible) {
    const normalized = useExact ? normalizeDense(entry.vector) : sketchVector(entry.vector);
    if (!normalized) normalizationFallback.push(entry);
    else {
      vectors.push(normalized);
      vectorEntries.push(entry);
    }
  }

  const allFallback = [...fallback, ...normalizationFallback].sort(stableFallbackCompare);
  if (vectorEntries.length <= 1) {
    return {
      ids: [...vectorEntries, ...allFallback].map((e) => String(e.id)),
      meta: {
        algorithmVersion: ALGORITHM_VERSION,
        vectorGroup: groupKey,
        withEmbedding: vectorEntries.length,
        withoutEmbedding: allFallback.length,
      },
    };
  }

  const distance = buildDistanceAccessor(vectors);
  const route = buildGreedyRoute(vectors, vectorEntries, distance);
  const greedyDistance = pathDistance(route, distance);
  optimizeTwoOpt(route, distance);
  const optimizedDistance = pathDistance(route, distance);

  return {
    ids: [
      ...route.map((idx) => String(vectorEntries[idx].id)),
      ...allFallback.map((entry) => String(entry.id)),
    ],
    meta: {
      algorithmVersion: ALGORITHM_VERSION,
      vectorGroup: groupKey,
      compareDimensions: vectors[0]?.length || 0,
      exactCosine: useExact,
      withEmbedding: vectorEntries.length,
      withoutEmbedding: allFallback.length,
      greedyDistance,
      optimizedDistance,
    },
  };
}

function mergeFrozenSequenceWithEligible(frozenIds, eligibleProducts) {
  const eligibleById = new Map(eligibleProducts.map((p) => [String(p.id ?? p._id), p]));
  const result = [];
  const seen = new Set();
  for (const rawId of frozenIds || []) {
    const id = String(rawId);
    if (!eligibleById.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  // Normally no seller-cycle product can appear here because firstBlockPlacedAt
  // cutoff freezes eligibility. Defensive append keeps the endpoint total and
  // complete if legacy data violates that assumption; it does NOT reshuffle the
  // already-frozen sequence.
  const extras = eligibleProducts
    .filter((p) => !seen.has(String(p.id ?? p._id)))
    .sort(stableFallbackCompare);
  for (const product of extras) result.push(String(product.id ?? product._id));
  return result;
}


module.exports = {
  ALGORITHM_VERSION,
  buildVisualSequence,
  mergeFrozenSequenceWithEligible,
};
