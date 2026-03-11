const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// --- Configuration ---
const HLS_TEMP_DIR = path.join(__dirname, 'hls_temp'); // Directory to store temporary HLS files
const STREAM_TIMEOUT = 30000; // 30 seconds

// In-memory store for active streams
const activeStreams = new Map();

// Ensure the temporary directory exists
if (!fs.existsSync(HLS_TEMP_DIR)) {
    fs.mkdirSync(HLS_TEMP_DIR, { recursive: true });
}

function getStreamManager(inputStreamUrl) {
    if (activeStreams.has(inputStreamUrl)) {
        return activeStreams.get(inputStreamUrl);
    }

    const streamId = Buffer.from(inputStreamUrl).toString('hex');
    const outputDir = path.join(HLS_TEMP_DIR, streamId);

    const manager = {
        id: streamId,
        url: inputStreamUrl,
        outputDir: outputDir,
        process: null,
        lastAccess: Date.now(),
        timeout: null,
        start: function() {
            if (this.process) {
                console.log(`[FFMPEG] Process for ${this.id} already running.`);
                return;
            }

            // Ensure a clean directory
            if (fs.existsSync(this.outputDir)) {
                fs.rmSync(this.outputDir, { recursive: true, force: true });
            }
            fs.mkdirSync(this.outputDir, { recursive: true });

            const args = [
                '-hide_banner',
                '-loglevel', 'error',

                // --- FINAL FIX: Explicitly tell FFmpeg the input format is HLS ---
                // This speeds up startup time for problematic HLS sources.
                '-f', 'hls',
                '-i', this.url,          // Input stream from the encoder

                // --- ROBUST AUDIO HANDLING ---
                // Re-encode video and audio. This will use the source audio if it exists,
                // or gracefully handle cases where it's missing or broken without crashing.
                '-c:v', 'libx264',       // Re-encode video with the highly compatible libx264
                '-preset', 'veryfast',  // Use minimal CPU, prioritize speed over quality
                '-tune', 'zerolatency', // Optimize for live streaming
                '-c:a', 'aac',           // Encode the silent audio track to AAC
                '-hls_time', '2',        // 2-second segments
                '-hls_playlist_type', 'event', // Create playlist immediately and append segments
                '-hls_list_size', '6',   // Keep 6 segments in the playlist
                '-hls_flags', 'delete_segments', // Delete old segments
                path.join(this.outputDir, 'index.m3u8') // Output playlist
            ];

            console.log(`[FFMPEG] Spawning for ${this.id}: ffmpeg ${args.join(' ')}`);
            
            // --- FINAL FIX: Run FFmpeg in a detached state ---
            // This prevents the Node.js process from blocking FFmpeg's execution
            // by not consuming its stdout/stderr streams quickly enough.
            this.process = spawn('ffmpeg', args, {
                detached: true,
                stdio: 'ignore' // Do not pipe stdout/stderr/stdin
            });

            this.process.on('close', (code) => {
                console.log(`[FFMPEG] Process for ${this.id} exited with code ${code}`);
                this.cleanup();
            });

            this.resetTimeout();
        },
        stop: function() {
            if (this.process) {
                console.log(`[FFMPEG] Killing process for ${this.id}`);
                // Use a negative PID to kill the entire process group, ensuring FFmpeg fully terminates.
                process.kill(-this.process.pid, 'SIGKILL');
            }
            this.cleanup();
        },
        cleanup: function() {
            console.log(`[CLEANUP] Removing files for stream ${this.id}`);
            if (fs.existsSync(this.outputDir)) {
                fs.rmSync(this.outputDir, { recursive: true, force: true });
            }
            activeStreams.delete(this.url);
        },
        resetTimeout: function() {
            this.lastAccess = Date.now();
            clearTimeout(this.timeout);
            this.timeout = setTimeout(() => {
                console.log(`[TIMEOUT] Stream ${this.id} inactive for ${STREAM_TIMEOUT / 1000}s. Shutting down.`);
                this.stop();
            }, STREAM_TIMEOUT);
        }
    };

    activeStreams.set(inputStreamUrl, manager);
    return manager;
}

router.get('/:base64Url/:file', async (req, res) => {
    const { base64Url, file } = req.params;

    try {
        const inputStreamUrl = Buffer.from(base64Url, 'base64').toString('ascii');
        if (!inputStreamUrl.startsWith('http')) {
            return res.status(400).send('Invalid stream URL.');
        }

        const manager = getStreamManager(inputStreamUrl);

        // --- FIX: Reset the inactivity timeout on EVERY request for this stream ---
        manager.resetTimeout();

        // If the process isn't running, start it
        if (!manager.process) {
            manager.start();
        }

        const filePath = path.join(manager.outputDir, file);

        // --- FIX: Wait for both the playlist AND the first segment to be ready ---
        if (file.endsWith('.m3u8')) {
            let attempts = 0;
            const maxAttempts = 90; // Increase wait time to 90 seconds for extremely slow streams
            let firstSegmentFound = false;
            let playlistFound = false;

            while (attempts < maxAttempts) {
                // --- FIX: Safely check if the directory exists before reading it ---
                if (fs.existsSync(manager.outputDir)) {
                    // Check if a .ts file exists in the directory
                    const files = fs.readdirSync(manager.outputDir);
                    firstSegmentFound = files.some(f => f.endsWith('.ts'));
                }

                playlistFound = fs.existsSync(filePath);

                // If we have the playlist AND at least one segment, we are ready.
                if (playlistFound && firstSegmentFound) break;

                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }

            // After the loop, check if we succeeded.
            if (playlistFound && firstSegmentFound) {
                return res.sendFile(filePath);
            } else {
                console.error(`[PROXY] Timeout: Stream did not start within ${maxAttempts} seconds.`);
                return res.status(504).send(`Stream Startup Timed Out. The source stream at ${inputStreamUrl} may be offline or incompatible.`);
            }
        } else if (fs.existsSync(filePath)) {
            // For .ts files, just send them if they exist.
            return res.sendFile(filePath);
        }

    } catch (error) {
        console.error('[PROXY] Error processing request:', error);
        res.status(500).send('Error processing stream request.');
    }
});

module.exports = router;

// Graceful shutdown
process.on('exit', () => {
    console.log('Server shutting down. Cleaning up active FFmpeg streams...');
    for (const manager of activeStreams.values()) {
        manager.stop();
    }
});