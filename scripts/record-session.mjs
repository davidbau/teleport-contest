#!/usr/bin/env node
// record-session.mjs — Re-record a session.json from a recipe.
//
// Reads an input session.json (clean v5 segments format), spawns the
// patched NetHack 5.0 "recorder" binary with NOMUX_MARKERS=1, drives
// it one key at a time using in-band stdout sync markers (OSC 7777),
// reads PRNG calls from the rng-log file, and writes a fresh
// session.json that is byte-equal to the canonical recordings.
//
// Usage:
//   node scripts/record-session.mjs <input.session.json> [output.session.json]
//
// Env:
//   NETHACK_BINARY     path to recorder/install/games/lib/nethackdir/nethack
//                      (defaults to nethack-c/recorder/install/...)
//   NETHACK_INSTALL    install dir (HACKDIR / NETHACKDIR)
//   RERECORD_TZ        timezone for the C process (default America/New_York)
//
// The recorder binary must be built from the patched submodule.
// See nethack-c/build-recorder.sh.

import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_BINARY = path.join(
    TEMPLATE_ROOT, 'nethack-c', 'recorder', 'install',
    'games', 'lib', 'nethackdir', 'nethack');
const DEFAULT_INSTALL = path.join(
    TEMPLATE_ROOT, 'nethack-c', 'recorder', 'install',
    'games', 'lib', 'nethackdir');

// ---------------------------------------------------------------------------
// Screen encoding — ports run_session.py compress_ansi_line +
// encode_screen_ansi_rle to produce byte-equal output.
// ---------------------------------------------------------------------------

function compressAnsiLine(line) {
    if (!line) return '';
    let out = '';
    let i = 0;
    while (i < line.length) {
        if (line[i] === ' ') {
            const start = i;
            while (i < line.length && line[i] === ' ') i++;
            const run = i - start;
            if (run >= 5) {
                out += `\x1b[${run}C`;
            } else {
                out += ' '.repeat(run);
            }
        } else {
            out += line[i];
            i += 1;
        }
    }
    return out;
}

function encodeScreenAnsiRle(lines) {
    if (!lines || lines.length === 0) return '';
    const compressed = lines.map((line) => {
        // Trailing spaces are implicit
        const stripped = line.replace(/ +$/u, '');
        return compressAnsiLine(stripped);
    });
    while (compressed.length > 0 && compressed[compressed.length - 1] === '') {
        compressed.pop();
    }
    return compressed.join('\n');
}

// ---------------------------------------------------------------------------
// OSC 7777 marker stream parser
// ---------------------------------------------------------------------------

// Marker wire format (emitted by patched termcap.c):
//   ESC ] 7777 ; KIND=input ; SEQ=N ; ANIM=K ; CX=cx ; CY=cy ; LEN=L BEL
//   <L bytes of screen content>
//
// The header up through BEL is plain ASCII. The L payload bytes are the
// rendered screen serialization (escape sequences preserved verbatim).
// The parser is byte-oriented and handles the payload as raw bytes — a
// BEL inside the payload must not terminate the next header.

class MarkerParser {
    constructor(onMarker) {
        this.onMarker = onMarker;
        // Chunks waiting to be parsed, plus a logical offset into the
        // first chunk.  Avoids O(n^2) Buffer.concat on hot streams.
        this.chunks = [];
        this.head = 0;        // bytes already consumed in chunks[0]
        this.size = 0;        // total unconsumed bytes
        this.stopped = false;
    }

    stop() { this.stopped = true; this.chunks = []; this.size = 0; this.head = 0; }

    push(chunk) {
        if (this.stopped) return;
        this.chunks.push(chunk);
        this.size += chunk.length;
        this._drain();
    }

    _flatten(n) {
        // Materialize the next n bytes into a single Buffer.
        const out = Buffer.allocUnsafe(n);
        let off = 0;
        let chunkIdx = 0;
        let chunkOff = this.head;
        while (off < n) {
            const c = this.chunks[chunkIdx];
            const take = Math.min(n - off, c.length - chunkOff);
            c.copy(out, off, chunkOff, chunkOff + take);
            off += take;
            chunkOff += take;
            if (chunkOff >= c.length) { chunkIdx += 1; chunkOff = 0; }
        }
        return out;
    }

    _consume(n) {
        // Discard the next n bytes from the queue.
        let remaining = n;
        while (remaining > 0 && this.chunks.length > 0) {
            const c = this.chunks[0];
            const avail = c.length - this.head;
            if (remaining < avail) {
                this.head += remaining;
                remaining = 0;
            } else {
                remaining -= avail;
                this.chunks.shift();
                this.head = 0;
            }
        }
        this.size -= n;
    }

    _findByte(byte, fromOffset) {
        // Locate `byte` starting at `fromOffset` bytes from the logical start.
        let skip = fromOffset;
        let chunkIdx = 0;
        let chunkOff = this.head;
        while (chunkIdx < this.chunks.length && skip > 0) {
            const c = this.chunks[chunkIdx];
            const avail = c.length - chunkOff;
            if (skip < avail) { chunkOff += skip; skip = 0; }
            else { skip -= avail; chunkIdx += 1; chunkOff = 0; }
        }
        let pos = fromOffset;
        while (chunkIdx < this.chunks.length) {
            const c = this.chunks[chunkIdx];
            const idx = c.indexOf(byte, chunkOff);
            if (idx >= 0) return pos + (idx - chunkOff);
            pos += c.length - chunkOff;
            chunkIdx += 1;
            chunkOff = 0;
        }
        return -1;
    }

    _findIntroducer() {
        // Returns the logical offset of "\x1b]7777;" from start, or -1.
        // Must check across chunk boundaries — flatten search by scanning
        // chunks one byte at a time around any ESC byte.
        let pos = 0;
        let chunkIdx = 0;
        let chunkOff = this.head;
        const needle = Buffer.from('\x1b]7777;');
        // Collect a small rolling window across chunks if needed.
        while (chunkIdx < this.chunks.length) {
            const c = this.chunks[chunkIdx];
            const sub = c.subarray(chunkOff);
            const idx = sub.indexOf(0x1b);
            if (idx < 0) {
                pos += sub.length;
                chunkIdx += 1; chunkOff = 0;
                continue;
            }
            // Try a 7-byte match starting at this ESC.  May span chunks.
            const startPos = pos + idx;
            if (this._matchAt(startPos, needle)) return startPos;
            // Skip past this ESC and continue.
            const stepBytes = idx + 1;
            pos += stepBytes;
            chunkOff += stepBytes;
            if (chunkOff >= c.length) { chunkIdx += 1; chunkOff = 0; }
        }
        return -1;
    }

    _matchAt(startOffset, needle) {
        if (this.size - startOffset < needle.length) return false;
        let needleOff = 0;
        let pos = 0;
        let chunkIdx = 0;
        let chunkOff = this.head;
        // Advance to startOffset
        while (pos < startOffset) {
            const c = this.chunks[chunkIdx];
            const avail = c.length - chunkOff;
            const skip = Math.min(avail, startOffset - pos);
            chunkOff += skip;
            pos += skip;
            if (chunkOff >= c.length) { chunkIdx += 1; chunkOff = 0; }
        }
        while (needleOff < needle.length) {
            const c = this.chunks[chunkIdx];
            const avail = c.length - chunkOff;
            const take = Math.min(avail, needle.length - needleOff);
            for (let i = 0; i < take; i++) {
                if (c[chunkOff + i] !== needle[needleOff + i]) return false;
            }
            needleOff += take;
            chunkOff += take;
            if (chunkOff >= c.length) { chunkIdx += 1; chunkOff = 0; }
        }
        return true;
    }

    _drain() {
        while (!this.stopped) {
            const introStart = this._findIntroducer();
            if (introStart < 0) {
                // Drop all bytes — no introducer in flight.  Leave at most
                // 6 trailing bytes in case an ESC starts a partial match.
                if (this.size > 7) this._consume(this.size - 7);
                return;
            }
            if (introStart > 0) this._consume(introStart);
            // Find BEL after the 7-byte introducer.
            const bel = this._findByte(0x07, 7);
            if (bel < 0) return;  // wait for more
            const headerBuf = this._flatten(bel);
            const header = headerBuf.subarray(7).toString('ascii');
            const meta = parseMarkerHeader(header);
            const need = bel + 1 + meta.len;
            if (this.size < need) return;  // wait for full payload
            const headerLen = bel + 1;
            this._consume(headerLen);
            const payloadBuf = this._flatten(meta.len);
            this._consume(meta.len);
            const payload = payloadBuf.toString('utf8');
            this.onMarker({ ...meta, payload });
            if (this.stopped) return;
        }
    }
}

function parseMarkerHeader(header) {
    const out = { kind: '', seq: 0, anim: 0, cx: 0, cy: 0, len: 0 };
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq);
        const v = part.slice(eq + 1);
        if (k === 'KIND') out.kind = v;
        else if (k === 'SEQ') out.seq = parseInt(v, 10) || 0;
        else if (k === 'ANIM') out.anim = parseInt(v, 10) || 0;
        else if (k === 'CX') out.cx = parseInt(v, 10) || 0;
        else if (k === 'CY') out.cy = parseInt(v, 10) || 0;
        else if (k === 'LEN') out.len = parseInt(v, 10) || 0;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Screen payload → 24-line array
// ---------------------------------------------------------------------------

function payloadToLines(payload) {
    const lines = payload.split('\n');
    while (lines.length < 24) lines.push('');
    return lines.slice(0, 24);
}

// ---------------------------------------------------------------------------
// PRNG log parsing (mirrors run_session.py parse_rng_lines)
// ---------------------------------------------------------------------------

function parseRngLines(text) {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        if (!line) continue;
        const c0 = line[0];
        if (c0 === '>' || c0 === '<' || c0 === '^') {
            out.push(line);
            continue;
        }
        // Format: "2808 rn2(12) = 2 @ mon.c:1145"
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        const rest = line.slice(sp + 1).replace(' = ', '=');
        out.push(rest);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Session loading / segment driving
// ---------------------------------------------------------------------------

async function loadSession(p) {
    const txt = await fs.readFile(p, 'utf8');
    const data = JSON.parse(txt);
    if (data.version !== 5 || !Array.isArray(data.segments)) {
        throw new Error(`unsupported session shape: ${p} (need clean v5)`);
    }
    return data;
}

function parseNethackrcName(rc) {
    if (!rc) return null;
    for (const rawLine of rc.split('\n')) {
        const line = rawLine.trim();
        const upper = line.toUpperCase();
        if (!(upper.startsWith('OPTIONS=') || upper.startsWith('OPTIONS ='))) continue;
        const opts = line.slice(line.indexOf('=') + 1);
        for (const opt of opts.split(',')) {
            const t = opt.trim();
            if (t.toLowerCase().startsWith('name:')) {
                return t.slice('name:'.length).trim();
            }
        }
    }
    return null;
}

async function ensureScorefiles(installDir) {
    for (const name of ['record', 'xlogfile', 'logfile']) {
        const p = path.join(installDir, name);
        try {
            const fh = await fs.open(p, 'a');
            await fh.close();
        } catch {}
    }
}

async function clearStaleState(installDir) {
    const saveDir = path.join(installDir, 'save');
    try {
        const entries = await fs.readdir(saveDir);
        await Promise.all(entries.map((e) => fs.unlink(path.join(saveDir, e)).catch(() => {})));
    } catch {}
    // Strip lock/bones/wizard files that interfere with deterministic replay.
    let entries = [];
    try { entries = await fs.readdir(installDir); } catch {}
    const killNames = new Set(['record', 'xlogfile', 'logfile', 'paniclog']);
    for (const name of entries) {
        const lower = name.toLowerCase();
        const full = path.join(installDir, name);
        let st;
        try { st = await fs.stat(full); } catch { continue; }
        if (!st.isFile()) continue;
        if (name.endsWith('.lua')) continue;
        if (killNames.has(lower)
            || lower.startsWith('bon')
            || lower.endsWith('.0')
            || lower.includes('wizard')
            || lower.includes('recorder')
            || lower.includes('agent')) {
            await fs.unlink(full).catch(() => {});
        }
    }
    await ensureScorefiles(installDir);
}

async function recordSegment({
    seg,
    isFirstSegment,
    binary,
    installDir,
    rngLogPath,
    homeDir,
    tz,
}) {
    // Write nethackrc into homeDir
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, '.nethackrc'), seg.nethackrc || '');
    // Reset rng log
    await fs.writeFile(rngLogPath, '');
    // Only wipe state on the first segment.  A multi-segment session
    // can be a save/restore pair: seg 0 ends with save+quit, seg 1
    // restarts NetHack and restores from the save file in
    // <install>/save/.  Clearing between segments would destroy that
    // save file and turn the restore into a fresh game.
    if (isFirstSegment) await clearStaleState(installDir);

    const playerName = parseNethackrcName(seg.nethackrc) ?? '';
    const args = ['-u', playerName];

    const env = {
        ...process.env,
        NETHACKDIR: installDir,
        HACKDIR: installDir,
        HOME: homeDir,
        TERM: 'xterm-256color',
        TZ: tz,
        NETHACK_NO_DELAY: '1',
        NETHACK_SEED: String(seg.seed ?? 0),
        NETHACK_FIXED_DATETIME: seg.datetime || '20000110090000',
        NETHACK_RNGLOG: rngLogPath,
        NOMUX_MARKERS: '1',
        NETHACK_RAW_KEYS: '1',
    };

    // Some legacy sessions have steps[].key populated but moves
    // empty. Fall back to reconstructing moves from step keys
    // (skipping the null initial step) so they replay.
    let moves = seg.moves ?? '';
    if (!moves && Array.isArray(seg.steps)) {
        const reconstructed = [];
        for (const s of seg.steps) {
            if (s.key != null) reconstructed.push(s.key);
        }
        moves = reconstructed.join('');
    }
    const expectedSteps = moves.length + 1;
    const steps = [];
    let lastRngBytes = 0;
    let nextKeyIdx = 0;
    let timeoutHandle = null;
    let resolveDone, rejectDone;
    let settled = false;
    const done = new Promise((res, rej) => {
        resolveDone = (v) => { if (!settled) { settled = true; res(v); } };
        rejectDone = (e) => { if (!settled) { settled = true; rej(e); } };
    });

    const armTimeout = (ms, why) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
            rejectDone(new Error(`recorder timeout: ${why} (after ${ms}ms)`));
        }, ms);
    };

    const child = spawn(binary, args, {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.stdin.on('error', () => {});

    armTimeout(20000, 'first marker');

    const readRngDelta = async () => {
        let rngText = '';
        try {
            const fh = await fs.open(rngLogPath, 'r');
            try {
                const st = await fh.stat();
                if (st.size > lastRngBytes) {
                    const buf = Buffer.alloc(st.size - lastRngBytes);
                    await fh.read(buf, 0, buf.length, lastRngBytes);
                    rngText = buf.toString('utf8');
                    lastRngBytes = st.size;
                }
            } finally {
                await fh.close();
            }
        } catch {}
        return parseRngLines(rngText);
    };

    const finish = (reason) => {
        parser.stop();
        if (timeoutHandle) clearTimeout(timeoutHandle);
        try { child.kill('SIGTERM'); } catch {}
        // Force close in case it ignores SIGTERM.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref();
        resolveDone(reason);
    };

    // Buffer of 'anim' markers received between consecutive 'input'
    // markers.  When the next input marker closes a step, the buffered
    // anim screens are attached to that step as `animation_frames`,
    // preserving order and step-attribution without extra stream markers.
    let pendingAnimFrames = [];
    const onMarker = async (m) => {
        if (m.kind === 'anim') {
            pendingAnimFrames.push({
                screen: encodeScreenAnsiRle(payloadToLines(m.payload)),
                cursor: [m.cx, m.cy, 1],
            });
            return;
        }
        if (m.kind !== 'input') return;
        if (steps.length >= expectedSteps) {
            // We have everything we need; tear down.
            finish('expected steps reached');
            return;
        }
        try {
            const screen = encodeScreenAnsiRle(payloadToLines(m.payload));
            const rng = await readRngDelta();
            const stepIdx = m.seq - 1;
            const key = stepIdx === 0 ? null : moves[stepIdx - 1] ?? null;
            const step = { key, rng, screen, cursor: [m.cx, m.cy, 1] };
            if (pendingAnimFrames.length) {
                step.animation_frames = pendingAnimFrames;
                pendingAnimFrames = [];
            }
            steps.push(step);

            if (steps.length >= expectedSteps) {
                finish('expected steps reached');
                return;
            }
            if (nextKeyIdx < moves.length) {
                let k = moves[nextKeyIdx++];
                // The canonical sessions were captured under tmux, whose pty
                // line discipline maps incoming CR (\r) to LF (\n) before the
                // application reads it (ICRNL).  Our pipe-based stdin has no
                // line discipline, so we replicate that translation on the
                // way out.  (DEL / 0x7f is fine to send verbatim because the
                // patched gettty seeds erase_char with '\177'.)
                if (k === '\r') k = '\n';
                // A session key is a code point in the 8-bit input domain
                // (a meta key such as M-e is the single char U+00E5), not
                // Unicode text: write one byte per key, as the tty reads it.
                // UTF-8 would send a key above U+007F as two or more bytes.
                child.stdin.write(Buffer.from(k, 'latin1'));
                armTimeout(20000, `after key ${nextKeyIdx}/${moves.length}`);
            } else if (!child.stdin.writableEnded) {
                try { child.stdin.end(); } catch {}
                armTimeout(10000, 'awaiting process exit');
            }
        } catch (err) {
            rejectDone(err);
        }
    };

    // Serialize marker handling: parser._drain() calls onMarker
    // synchronously, but onMarker is async (file IO + stdin write).
    // Without a queue, two markers in one chunk would race the
    // shared lastRngBytes pointer.
    let chain = Promise.resolve();
    const serialMarker = (m) => {
        chain = chain.then(() => onMarker(m)).catch(rejectDone);
    };
    const parser = new MarkerParser(serialMarker);
    child.stdout.on('data', (chunk) => {
        try { parser.push(chunk); } catch (err) { rejectDone(err); }
    });
    child.stdout.on('error', (err) => rejectDone(err));
    child.on('error', (err) => rejectDone(err));
    child.on('close', (code, signal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        parser.stop();
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            // Killed by us after collecting expected steps.
            resolveDone(0);
            return;
        }
        // For death sessions the game can terminate before all keys are
        // consumed (the death itself fires nh_terminate); record whatever
        // steps we got and let the caller compare against the canonical
        // session, which captures the same truncated trace.
        resolveDone(code ?? 0);
    });

    await done;
    return steps.slice(0, expectedSteps);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function exists(p) {
    try { await fs.access(p, fsConstants.F_OK); return true; }
    catch { return false; }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length < 1 || argv[0] === '-h' || argv[0] === '--help') {
        console.error('Usage: node scripts/record-session.mjs <input.session.json> [output.session.json]');
        process.exit(2);
    }
    const inputPath = path.resolve(argv[0]);
    const outputPath = argv[1] ? path.resolve(argv[1]) : inputPath;

    const binary = process.env.NETHACK_BINARY || DEFAULT_BINARY;
    const installDir = process.env.NETHACK_INSTALL || DEFAULT_INSTALL;
    const tz = process.env.RERECORD_TZ || 'America/New_York';

    if (!await exists(binary)) {
        throw new Error(`recorder binary not found: ${binary}\n  build it via nethack-c/build-recorder.sh`);
    }
    if (!await exists(installDir)) {
        throw new Error(`install dir not found: ${installDir}`);
    }

    const session = await loadSession(inputPath);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nh-rec-'));
    const rngLogPath = path.join(tmpDir, 'rng.log');
    const homeDir = path.join(tmpDir, 'home');

    try {
        const newSegments = [];
        for (let i = 0; i < session.segments.length; i++) {
            const seg = session.segments[i];
            console.error(`[seg ${i + 1}/${session.segments.length}] seed=${seg.seed} moves=${(seg.moves || '').length}`);
            const steps = await recordSegment({
                seg,
                isFirstSegment: i === 0,
                binary,
                installDir,
                rngLogPath,
                homeDir,
                tz,
            });
            const out = {
                seed: seg.seed,
                datetime: seg.datetime,
                nethackrc: seg.nethackrc,
                moves: seg.moves,
                steps,
            };
            // Preserve any extra per-segment fields (e.g. checkpoints) that
            // existed in the input — we only overwrite steps.
            for (const k of Object.keys(seg)) {
                if (!(k in out)) out[k] = seg[k];
            }
            newSegments.push(out);
        }

        const outDoc = {
            version: 5,
            segments: newSegments,
        };
        for (const k of Object.keys(session)) {
            if (k !== 'version' && k !== 'segments') outDoc[k] = session[k];
        }

        await fs.writeFile(outputPath, JSON.stringify(outDoc));
        console.error(`[ok] wrote ${outputPath}`);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch((err) => {
    console.error('[fail]', err.message || err);
    process.exit(1);
});
