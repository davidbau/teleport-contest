// session_loader.mjs — Load a session JSON file and normalize it
// into the clean v5 shape, regardless of the legacy form it was
// written in.
//
// Clean v5 segment (the only shape downstream code sees):
//   {
//       seed: number,         // PRNG seed
//       datetime: string,     // fixed datetime, "YYYYMMDDHHMMSS"
//       nethackrc: string,    // game-options rc file contents
//       moves: string,        // raw key sequence to replay from launch
//       steps: [...]          // recorded comparison data
//   }
//
// Clean v5 session:
//   {
//       version: 5,
//       segments: [<segment>, ...],
//       recorded_with: {...},   // optional
//       source: "c" | "js"      // optional
//   }
//
// Legacy shapes accepted on input (auto-converted):
//   - v4 (top-level seed/env/nethackrc/regen/steps), wrapped into a
//     single-segment session
//   - v5 with env+regen wrappers, fields promoted to flat shape
//
// node:fs is loaded lazily inside loadSession() so this module stays
// browser-safe.

const DEFAULT_DATETIME = '20000110090000';

// Per-segment fields that get promoted/renamed during normalization.
// Anything else on a segment is preserved as-is (e.g. `checkpoints`,
// `animation_frames`, `exit`).
const SEGMENT_TRANSFORMED_FIELDS = new Set([
    'seed', 'env', 'nethackrc', 'regen', 'moves', 'datetime', 'steps',
]);

// Top-level session fields the normalizer recognizes from v4 input
// (used to filter v4 segment fields out of session-level metadata).
const SESSION_LEVEL_FIELDS = new Set([
    'recorded_with', 'source', 'shared', 'options', 'jsGroundTruth',
]);

function normalizeSegment(seg) {
    const out = {
        seed: typeof seg.seed === 'number' ? seg.seed
              : parseInt(seg.env?.NETHACK_SEED || '0'),
        datetime: seg.datetime || seg.env?.NETHACK_FIXED_DATETIME || DEFAULT_DATETIME,
        nethackrc: seg.nethackrc || '',
        moves: seg.moves || seg.regen?.moves || '',
        steps: seg.steps || [],
    };
    // Preserve any other segment-level fields that aren't part of the
    // canonical 5-field shape (checkpoints, animation_frames, exit).
    // Skip session-level fields that may have leaked in (legacy v4
    // input has session-level metadata at the same top level as segment
    // fields).
    for (const key of Object.keys(seg)) {
        if (SEGMENT_TRANSFORMED_FIELDS.has(key)) continue;
        if (SESSION_LEVEL_FIELDS.has(key)) continue;
        if (key === 'version') continue;
        if (key in out) continue;
        out[key] = seg[key];
    }
    return out;
}

/**
 * Normalize a session object to clean v5. Idempotent on already-clean
 * v5 input.
 */
export function normalizeSession(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('session must be an object');
    }
    let rawSegments;
    let topLevelSource;
    if (data.version === 5 && Array.isArray(data.segments)) {
        rawSegments = data.segments;
        topLevelSource = data;
    } else {
        // v4 / legacy: top-level holds segment fields too. Wrap as a
        // one-segment session and pull session-level metadata from the
        // top level using the SESSION_LEVEL_FIELDS allowlist.
        rawSegments = [data];
        topLevelSource = data;
    }
    const segments = rawSegments.map(normalizeSegment);
    const out = { version: 5, segments };
    for (const key of Object.keys(topLevelSource)) {
        if (key === 'version' || key === 'segments') continue;
        // For v4 input, only carry recognized session-level fields up.
        // For v5 input, carry everything that isn't version/segments.
        if (data.version === 5 || SESSION_LEVEL_FIELDS.has(key)) {
            out[key] = topLevelSource[key];
        }
    }
    return out;
}

/** Read a session JSON file and return its normalized v5 form. Node only. */
export async function loadSession(path) {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(path, 'utf8');
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        throw new Error(`${path}: invalid JSON — ${e.message}`);
    }
    return normalizeSession(data);
}
