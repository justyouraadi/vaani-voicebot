/**
 * 🎙️ VaaniAI — Real-Time Gemini Live Agent Engine
 *
 * KEY AUDIO APPROACH: Each TTS chunk is requested as a FULL WAV BLOB (not raw PCM streaming).
 * This mirrors the working Voice Cloner logic and avoids all PCM byte-alignment / Web Audio API issues.
 * Audio blobs are queued and played sequentially via native HTML5 Audio elements.
 */

const API_BASE = window.location.origin + '/api';

// DOM Elements
const els = {
    serverStatus: document.getElementById('serverStatusText'),
    liveVoiceSelect: document.getElementById('liveVoiceSelect'),
    geminiOrb: document.getElementById('geminiOrb'),
    orbIcon: document.getElementById('orbIcon'),
    orbStatusText: document.getElementById('orbStatusText'),
    btnLiveCall: document.getElementById('btnLiveCall'),
    callBtnText: document.getElementById('callBtnText'),
    metricTTFA: document.getElementById('metricTTFA'),
    metricDuration: document.getElementById('metricDuration'),
    metricBargeIn: document.getElementById('metricBargeIn'),
    transcriptFeed: document.getElementById('transcriptFeed'),
    btnClearTranscript: document.getElementById('btnClearTranscript'),
};

// Live Call State
let isLiveCallActive = false;
let ws = null;
let audioCtx = null;
let micStream = null;
let workletNode = null;
let callStartTime = null;
let durationInterval = null;

// Audio Playback Queue (WAV Blobs played via HTML Audio)
let audioQueue = [];
let isPlayingAudio = false;
let currentAudio = null;
let turnWavChunks = [];    // accumulate PCM bytes for download
let activeAiBubble = null;
let activeAiBubbleText = '';

// Pending byte buffer for WAV accumulation (from raw PCM stream)
let pendingByteQueue = new Uint8Array(0);

// Initialize
async function init() {
    await fetchVoices();
    setupEventListeners();
}

async function fetchVoices() {
    try {
        const response = await fetch(`${API_BASE}/voices`);
        if (!response.ok) throw new Error('Failed to fetch voices');
        const data = await response.json();
        const voices = data.voices || [];
        els.liveVoiceSelect.innerHTML = '';
        if (voices.length === 0) {
            els.liveVoiceSelect.innerHTML = '<option value="" disabled selected>No voices available</option>';
            return;
        }
        voices.forEach((voice, index) => {
            const opt = document.createElement('option');
            opt.value = voice.filename;
            opt.textContent = voice.name;
            if (index === 0) opt.selected = true;
            els.liveVoiceSelect.appendChild(opt);
        });
    } catch (error) {
        console.error('Error fetching voices:', error);
        els.serverStatus.textContent = 'Disconnected';
    }
}

// ─────────────────────────────────────────────
// 🎙️ LIVE CALL ENGINE
// ─────────────────────────────────────────────

function setupEventListeners() {
    els.btnLiveCall.addEventListener('click', toggleLiveCall);
    els.btnClearTranscript.addEventListener('click', () => {
        els.transcriptFeed.innerHTML = `
            <div class="chat-placeholder">
                <p>Click <strong>"Start Live Conversation"</strong> and speak. Vaani's response will stream here live.</p>
            </div>`;
    });
}

async function toggleLiveCall() {
    if (!isLiveCallActive) {
        await startLiveCall();
    } else {
        stopLiveCall();
    }
}

async function startLiveCall() {
    try {
        // Web Audio for mic capture only (NOT for playback — playback uses HTML Audio)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await audioCtx.audioWorklet.addModule('/audio-worklet.js');

        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
        });

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/audio`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            isLiveCallActive = true;
            updateCallUI('connecting');

            const source = audioCtx.createMediaStreamSource(micStream);
            workletNode = new AudioWorkletNode(audioCtx, 'vaani-audio-processor', {
                processorOptions: { sampleRate: audioCtx.sampleRate }
            });

            workletNode.port.onmessage = (event) => {
                if (event.data.type === 'audio' && ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(event.data.buffer);
                }
            };

            source.connect(workletNode);
            workletNode.connect(audioCtx.destination);

            callStartTime = Date.now();
            durationInterval = setInterval(() => {
                els.metricDuration.textContent = `${((Date.now() - callStartTime) / 1000).toFixed(1)}s`;
            }, 100);
        };

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                handleJsonMessage(JSON.parse(event.data));
            } else if (event.data instanceof ArrayBuffer) {
                // Raw PCM bytes from TTS server — accumulate into a WAV blob per turn
                accumulatePCMChunk(event.data);
            }
        };

        ws.onclose = () => stopLiveCall();
        ws.onerror = (err) => { console.error('WS Error:', err); stopLiveCall(); };

    } catch (err) {
        alert('Failed to start live call: ' + err.message);
        stopLiveCall();
    }
}

function stopLiveCall() {
    isLiveCallActive = false;

    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }

    finalizeAndAttachDownload();
    stopAllAudio();
    updateCallUI('idle');
}

function updateCallUI(state) {
    els.geminiOrb.className = `orb-container ${state}`;
    if (state === 'idle') {
        els.btnLiveCall.classList.remove('active-call');
        els.callBtnText.textContent = 'Start Live Conversation';
        els.orbIcon.textContent = '🎙️';
        els.orbStatusText.textContent = 'Ready to Talk';
        els.metricBargeIn.textContent = 'Active (Ready)';
    } else if (state === 'connecting') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = 'End Call';
        els.orbIcon.textContent = '⏳';
        els.orbStatusText.textContent = 'Connecting...';
    } else if (state === 'listening') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = 'End Call';
        els.orbIcon.textContent = '👂';
        els.orbStatusText.textContent = 'Listening to you...';
        finalizeAndAttachDownload();
    } else if (state === 'thinking') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = 'End Call';
        els.orbIcon.textContent = '🧠';
        els.orbStatusText.textContent = 'Thinking...';
    } else if (state === 'speaking') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = 'End Call';
        els.orbIcon.textContent = '🔊';
        els.orbStatusText.textContent = 'Vaani is speaking...';
    }
}

// ─────────────────────────────────────────────
// Message Handling
// ─────────────────────────────────────────────

function handleJsonMessage(msg) {
    if (msg.type === 'ready') {
        updateCallUI('listening');
    } else if (msg.type === 'state') {
        updateCallUI(msg.state);
    } else if (msg.type === 'transcription') {
        finalizeAndAttachDownload();
        appendChatBubble('user', msg.text);
        activeAiBubble = null;
        activeAiBubbleText = '';
        turnWavChunks = [];
        pendingByteQueue = new Uint8Array(0);
    } else if (msg.type === 'ai_text') {
        if (!activeAiBubble) {
            activeAiBubble = appendChatBubble('ai', '');
            activeAiBubbleText = '';
        }
        activeAiBubbleText += msg.text;
        activeAiBubble.querySelector('.chat-text').textContent = activeAiBubbleText;
        scrollToBottom();
    } else if (msg.type === 'metrics') {
        if (msg.ttfa_ms) els.metricTTFA.textContent = `${msg.ttfa_ms} ms`;
    } else if (msg.type === 'barge_in') {
        stopAllAudio();
        finalizeAndAttachDownload();
        els.metricBargeIn.textContent = 'Interrupted!';
        setTimeout(() => els.metricBargeIn.textContent = 'Active (Ready)', 2000);
    }
}

// ─────────────────────────────────────────────
// PCM Accumulator → WAV Blob → HTML Audio Queue
// ─────────────────────────────────────────────

function accumulatePCMChunk(arrayBuffer) {
    // Step 1: Accumulate raw PCM bytes (2-byte aligned)
    const incomingBytes = new Uint8Array(arrayBuffer);
    const merged = new Uint8Array(pendingByteQueue.length + incomingBytes.length);
    merged.set(pendingByteQueue, 0);
    merged.set(incomingBytes, pendingByteQueue.length);

    const evenLen = Math.floor(merged.length / 2) * 2;
    if (evenLen === 0) { pendingByteQueue = merged; return; }

    const aligned = merged.subarray(0, evenLen);
    pendingByteQueue = merged.subarray(evenLen);

    // Step 2: Collect for per-turn download
    turnWavChunks.push(new Uint8Array(aligned));

    // Step 3: Create a proper WAV blob from these PCM bytes and queue for playback
    const int16Samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
    const wavBlob = buildWavBlob(int16Samples, 24000);
    enqueueAudioBlob(wavBlob);
}

function enqueueAudioBlob(wavBlob) {
    audioQueue.push(wavBlob);
    if (!isPlayingAudio) {
        playNextInQueue();
    }
}

function playNextInQueue() {
    if (audioQueue.length === 0) {
        isPlayingAudio = false;
        return;
    }

    isPlayingAudio = true;
    const blob = audioQueue.shift();
    const url = URL.createObjectURL(blob);

    currentAudio = new Audio(url);
    currentAudio.volume = 1.0;

    currentAudio.onended = () => {
        URL.revokeObjectURL(url);
        playNextInQueue();
    };

    currentAudio.onerror = (e) => {
        console.error('Audio playback error:', e);
        URL.revokeObjectURL(url);
        playNextInQueue();
    };

    currentAudio.play().catch(e => {
        console.error('Audio play() failed:', e);
        URL.revokeObjectURL(url);
        playNextInQueue();
    });
}

function stopAllAudio() {
    audioQueue = [];
    isPlayingAudio = false;
    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        try { currentAudio.pause(); } catch (e) {}
        currentAudio.src = '';
        currentAudio = null;
    }
    pendingByteQueue = new Uint8Array(0);
}

// ─────────────────────────────────────────────
// Per-Turn Downloadable WAV File
// ─────────────────────────────────────────────

function finalizeAndAttachDownload() {
    if (!activeAiBubble || turnWavChunks.length === 0) return;

    const slot = activeAiBubble.querySelector('.audio-download-slot');
    if (!slot || slot.innerHTML.trim()) return;

    // Merge all PCM byte chunks into one Int16Array
    const totalBytes = turnWavChunks.reduce((s, c) => s + c.length, 0);
    const allBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of turnWavChunks) { allBytes.set(chunk, offset); offset += chunk.length; }

    const int16Samples = new Int16Array(allBytes.buffer, 0, allBytes.byteLength / 2);
    const wavBlob = buildWavBlob(int16Samples, 24000);
    const url = URL.createObjectURL(wavBlob);

    slot.innerHTML = `
        <a href="${url}" download="vaani_response_${Date.now()}.wav" class="btn-download-wav">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>Download Audio (WAV)</span>
        </a>`;

    turnWavChunks = [];
}

// ─────────────────────────────────────────────
// WAV Blob Builder Utility
// ─────────────────────────────────────────────

function buildWavBlob(int16Samples, sampleRate) {
    const dataLen = int16Samples.length * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);

    // RIFF header
    writeStr(v, 0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    writeStr(v, 8, 'WAVE');
    writeStr(v, 12, 'fmt ');
    v.setUint32(16, 16, true);        // chunk size
    v.setUint16(20, 1, true);         // PCM format
    v.setUint16(22, 1, true);         // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);         // block align
    v.setUint16(34, 16, true);        // bits per sample
    writeStr(v, 36, 'data');
    v.setUint32(40, dataLen, true);

    // PCM samples
    let off = 44;
    for (let i = 0; i < int16Samples.length; i++, off += 2) {
        v.setInt16(off, int16Samples[i], true);
    }

    return new Blob([buf], { type: 'audio/wav' });
}

function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ─────────────────────────────────────────────
// Chat Bubble Helpers
// ─────────────────────────────────────────────

function appendChatBubble(sender, text) {
    const placeholder = els.transcriptFeed.querySelector('.chat-placeholder');
    if (placeholder) placeholder.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${sender}`;
    bubble.innerHTML = `
        <span class="chat-sender">${sender === 'user' ? 'You' : 'Vaani'}</span>
        <span class="chat-text">${text}</span>
        <div class="audio-download-slot"></div>
    `;
    els.transcriptFeed.appendChild(bubble);
    scrollToBottom();
    return bubble;
}

function scrollToBottom() {
    els.transcriptFeed.scrollTop = els.transcriptFeed.scrollHeight;
}

// Run
init();
