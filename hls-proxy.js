const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// --- Configuration ---
const HLS_TEMP_DIR = path.join(__dirname, 'hls_temp');   // Directory for temporary HLS files
const LOG_DIR = path.join(__dirname, 'logs');            // FFmpeg stderr logs live here
const STREAM_IDLE_TIMEOUT = 5 * 60 * 1000;               // Kill FFmpeg after 5 min with no client requests
const STARTUP_MAX_WAIT_MS = 20000;                       // Max wait for playlist + first segment (copy mode is fast)
const STARTUP_POLL_MS = 250;                             // Poll interval while waiting for startup
const RESTART_BASE_DELAY_MS = 1000;                      // First restart delay after unexpected exit
const RESTART_MAX_DELAY_MS = 30000;                      // Cap for exponential backoff
const RESTART_BACKOFF_RESET_MS = 60000;                  // If FFmpeg ran this long, reset backoff to base

// In-memory store for active streams (keyed by source URL)
const activeStreams = new Map();

// Ensure working directories exist
for (const dir of [HLS_TEMP_DIR, LOG_DIR]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getStreamManager(inputStreamUrl) {
    if (activeStreams.has(inputStreamUrl)) {
        return activeStreams.get(inputStreamUrl);
    }

    const streamId = Buffer.from(inputStreamUrl).toString('hex');
    const outputDir = path.join(HLS_TEMP_DIR, streamId);
    const logPath = path.join(LOG_DIR, `ffmpeg-${streamId}.log`);

    const manager = {
        id: streamId,
        url: inputStreamUrl,
        outputDir,
        logPath,
        process: null,
        stopping: false,          // true only when stop() was deliberate — suppresses restart
        restartTimer: null,
        restartDelay: RESTART_BASE_DELAY_MS,
        startedAt: null,
        lastAccess: Date.now(),
        idleTimer: null,

        start() {
            if (this.process) {
                return; // already running
            }
            this.stopping = false;

            // Clean slate for output files
            if (fs.existsSync(this.outputDir)) {
                fs.rmSync(this.outputDir, { recursive: true, force: true });
            }
            fs.mkdirSync(this.outputDir, { recursive: true });

            // NOTE: input should be the encoder's continuous HTTP-TS output
            // (e.g. http://10.17.0.8:8080/h3.ts). No -f on the input side —
            // let FFmpeg probe it, so this also works if someone configures
            // an .m3u8 or RTSP source instead.
            const args = [
                '-hide_banner',
                '-loglevel', 'warning',

                // Reconnect automatically if the HTTP source drops (belt +
                // suspenders alongside our process-level restart supervision).
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',

                '-f', 'mpegts',     // Change this if the format changes

                '-i', this.url,

                // The Spartan already emits browser-compatible H.264 + AAC,
                // so copy the streams untouched. Near-zero CPU, no quality
                // loss, and no risk of the encode falling behind realtime.
                '-c', 'copy',

                // Rolling live window: 6 x 2s segments, old segments deleted,
                // no EXT-X-ENDLIST so players treat it as a live stream.
                '-f', 'hls',
                '-hls_time', '2',
                '-hls_list_size', '6',
                '-hls_flags', 'delete_segments+append_list+omit_endlist',
                '-hls_segment_filename', path.join(this.outputDir, 'seg%05d.ts'),
                path.join(this.outputDir, 'index.m3u8')
            ];

            console.log(`[FFMPEG] Spawning for ${this.id}: ffmpeg ${args.join(' ')}`);

            // Append stderr to a per-stream log file so failures are diagnosable.
            const logFd = fs.openSync(this.logPath, 'a');
            fs.writeSync(logFd, `\n--- FFmpeg start ${new Date().toISOString()} for ${this.url} ---\n`);

            this.startedAt = Date.now();
            this.process = spawn('ffmpeg', args, {
                stdio: ['ignore', 'ignore', logFd]
            });
            fs.closeSync(logFd); // child holds its own copy of the fd

            this.process.on('error', (err) => {
                console.error(`[FFMPEG] Failed to spawn for ${this.id}:`, err.message);
                this.process = null;
                this.scheduleRestart();
            });

            this.process.on('close', (code, signal) => {
                console.log(`[FFMPEG] Process for ${this.id} exited (code=${code}, signal=${signal})`);
                this.process = null;

                if (this.stopping) {
                    // Deliberate stop — clean up and forget this stream.
                    this.cleanup();
                    return;
                }

                // Unexpected exit: keep output files on disk so clients can
                // continue draining their buffers, and restart with backoff.
                console.warn(`[FFMPEG] Unexpected exit for ${this.id}. See ${this.logPath}. Restarting...`);
                this.scheduleRestart();
            });

            this.resetIdleTimer();
        },

        scheduleRestart() {
            if (this.stopping || this.restartTimer) return;

            // If the last run survived a while, treat this as a fresh failure
            // and start backoff from the base delay again.
            if (this.startedAt && Date.now() - this.startedAt > RESTART_BACKOFF_RESET_MS) {
                this.restartDelay = RESTART_BASE_DELAY_MS;
            }

            const delay = this.restartDelay;
            this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_DELAY_MS);

            console.log(`[FFMPEG] Restarting ${this.id} in ${delay}ms`);
            this.restartTimer = setTimeout(() => {
                this.restartTimer = null;
                if (!this.stopping) {
                    this.start();
                }
            }, delay);
        },

        stop() {
            this.stopping = true;

            if (this.restartTimer) {
                clearTimeout(this.restartTimer);
                this.restartTimer = null;
            }
            clearTimeout(this.idleTimer);

            if (this.process) {
                console.log(`[FFMPEG] Stopping process for ${this.id}`);
                try {
                    this.process.kill('SIGTERM');
                    // Escalate if it hasn't exited shortly (e.g. wedged on network I/O)
                    const proc = this.process;
                    setTimeout(() => {
                        if (proc && proc.exitCode === null && !proc.killed) {
                            try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
                        }
                    }, 5000);
                } catch (err) {
                    console.error(`[FFMPEG] Error killing process for ${this.id}:`, err.message);
                    this.cleanup();
                }
            } else {
                this.cleanup();
            }
        },

        cleanup() {
            console.log(`[CLEANUP] Removing files for stream ${this.id}`);
            if (fs.existsSync(this.outputDir)) {
                fs.rmSync(this.outputDir, { recursive: true, force: true });
            }
            activeStreams.delete(this.url);
        },

        resetIdleTimer() {
            this.lastAccess = Date.now();
            clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => {
                console.log(`[TIMEOUT] Stream ${this.id} idle for ${STREAM_IDLE_TIMEOUT / 1000}s. Shutting down.`);
                this.stop();
            }, STREAM_IDLE_TIMEOUT);
        }
    };

    activeStreams.set(inputStreamUrl, manager);
    return manager;
}

// Wait until the playlist file and at least one segment exist.
async function waitForStreamReady(manager, playlistPath) {
    const deadline = Date.now() + STARTUP_MAX_WAIT_MS;

    while (Date.now() < deadline) {
        const playlistExists = fs.existsSync(playlistPath);
        let segmentExists = false;

        if (fs.existsSync(manager.outputDir)) {
            segmentExists = fs.readdirSync(manager.outputDir).some(f => f.endsWith('.ts'));
        }

        if (playlistExists && segmentExists) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, STARTUP_POLL_MS));
    }
    return false;
}

router.get('/:base64Url/:file', async (req, res) => {
    const { base64Url, file } = req.params;

    try {
        const inputStreamUrl = Buffer.from(base64Url, 'base64').toString('ascii');
        if (!inputStreamUrl.startsWith('http')) {
            return res.status(400).send('Invalid stream URL.');
        }

        // Guard against path traversal in the file param — we only ever
        // serve flat files from the stream's own output directory.
        const safeFile = path.basename(file);
        if (safeFile !== file || !(file.endsWith('.m3u8') || file.endsWith('.ts'))) {
            return res.status(400).send('Invalid file request.');
        }

        const manager = getStreamManager(inputStreamUrl);
        manager.resetIdleTimer();

        if (!manager.process && !manager.restartTimer) {
            manager.start();
        }

        const filePath = path.join(manager.outputDir, safeFile);

        // Live HLS must never be cached by the browser or intermediaries.
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        if (safeFile.endsWith('.m3u8')) {
            const ready = await waitForStreamReady(manager, filePath);
            if (ready) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                return res.sendFile(filePath);
            }
            console.error(`[PROXY] Timeout: stream ${manager.id} not ready within ${STARTUP_MAX_WAIT_MS / 1000}s. Check ${manager.logPath}`);
            return res.status(504).send(`Stream startup timed out. The source at ${inputStreamUrl} may be offline or incompatible.`);
        }

        // Segment request. If it's missing (deleted from the live window, or
        // not written yet), answer 404 IMMEDIATELY — hls.js handles a 404
        // gracefully by retrying/advancing, but a hung request stalls the
        // player forever. This was the primary cause of the freeze.
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'video/mp2t');
            return res.sendFile(filePath);
        }
        return res.status(404).send('Segment not found.');

    } catch (error) {
        console.error('[PROXY] Error processing request:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing stream request.');
        }
    }
});

// Lightweight status endpoint for debugging: /api/hls-proxy/status
router.get('/status', (req, res) => {
    const streams = [];
    for (const manager of activeStreams.values()) {
        streams.push({
            id: manager.id,
            url: manager.url,
            running: !!manager.process,
            pid: manager.process ? manager.process.pid : null,
            pendingRestart: !!manager.restartTimer,
            lastAccess: new Date(manager.lastAccess).toISOString(),
            uptimeSeconds: manager.startedAt && manager.process
                ? Math.round((Date.now() - manager.startedAt) / 1000)
                : 0,
            logFile: manager.logPath
        });
    }
    res.json({ activeStreams: streams.length, streams });
});

module.exports = router;

// Graceful shutdown — kill child FFmpeg processes when the server exits.
function shutdownAll() {
    console.log('Shutting down: cleaning up active FFmpeg streams...');
    for (const manager of activeStreams.values()) {
        manager.stopping = true;
        if (manager.process) {
            try { manager.process.kill('SIGKILL'); } catch (_) { /* already gone */ }
        }
    }
}

process.on('exit', shutdownAll);
process.on('SIGINT', () => { shutdownAll(); process.exit(0); });
process.on('SIGTERM', () => { shutdownAll(); process.exit(0); });