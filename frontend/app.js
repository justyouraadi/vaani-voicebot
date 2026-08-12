/**
 * 🎙️ VaaniAI — Real-Time Gemini Live Agent
 *
 * AUDIO ARCHITECTURE:
 * ───────────────────
 * The server sends audio as complete WAV blobs (one per sentence chunk).
 * Protocol:
 *   Server → JSON: {"type": "audio_wav", "chunk_index": 0, "bytes": N}
 *   Server → Binary: <N bytes of complete WAV file>
 *
 * The browser queues WAV blobs and plays them with native Audio elements.
 * Chunk 1 starts playing while chunk 2 is still being synthesized on the server.
 * This is the same proven approach as the Voice Cloner (which produced perfect audio).
 */

const API_BASE = window.location.origin + '/api';

// DOM refs
const els = {
    serverStatus:       document.getElementById('serverStatusText'),
    liveVoiceSelect:    document.getElementById('liveVoiceSelect'),
    geminiOrb:          document.getElementById('geminiOrb'),
    orbIcon:            document.getElementById('orbIcon'),
    orbStatusText:      document.getElementById('orbStatusText'),
    btnLiveCall:        document.getElementById('btnLiveCall'),
    callBtnText:        document.getElementById('callBtnText'),
    metricTTFA:         document.getElementById('metricTTFA'),
    metricDuration:     document.getElementById('metricDuration'),
    metricBargeIn:      document.getElementById('metricBargeIn'),
    transcriptFeed:     document.getElementById('transcriptFeed'),
    btnClearTranscript: document.getElementById('btnClearTranscript'),
};

// Call state
let isLiveCallActive = false;
let ws               = null;
let audioCtx         = null;
let micStream        = null;
let workletNode      = null;
let callStartTime    = null;
let durationInterval = null;

// WAV Queue (HTML Audio playback)
let audioQueue       = [];
let isPlayingAudio   = false;
let currentAudio     = null;
let expectingWavBlob = false;

// Per-turn accumulator (for download button)
let turnWavBlobs     = [];
let activeAiBubble   = null;
let activeAiBubbleText = '';

// Init
async function init() {
    await fetchVoices();
    setupEventListeners();
    updateCallUI('idle');
}

async function fetchVoices() {
    try {
        const resp = await fetch(`${API_BASE}/voices`);
        if (!resp.ok) throw new Error('Cannot fetch voices');
        const data = await resp.json();
        if (!els.liveVoiceSelect) return;
        els.liveVoiceSelect.innerHTML = '';
        (data.voices || []).forEach((v, i) => {
            const opt = document.createElement('option');
            opt.value = v.filename;
            opt.textContent = v.name;
            if (i === 0) opt.selected = true;
            els.liveVoiceSelect.appendChild(opt);
        });
    } catch (e) {
        console.error('fetchVoices:', e);
        if (els.serverStatus) els.serverStatus.textContent = 'Disconnected';
    }
}

// Event Listeners
function setupEventListeners() {
    els.btnLiveCall?.addEventListener('click', toggleLiveCall);
    els.btnClearTranscript?.addEventListener('click', () => {
        if (els.transcriptFeed) {
            els.transcriptFeed.innerHTML = `
                <div class="chat-placeholder">
                    <p>Click <strong>"Start Live Conversation"</strong> and speak.</p>
                </div>`;
        }
    });
}

// Live Call
async function toggleLiveCall() {
    isLiveCallActive ? stopLiveCall() : await startLiveCall();
}

async function startLiveCall() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await audioCtx.audioWorklet.addModule('/audio-worklet.js');

        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
        });

        const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProto}//${window.location.host}/ws/audio`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            isLiveCallActive = true;
            updateCallUI('connecting');

            const source = audioCtx.createMediaStreamSource(micStream);
            workletNode = new AudioWorkletNode(audioCtx, 'vaani-audio-processor', {
                processorOptions: { sampleRate: audioCtx.sampleRate }
            });
            workletNode.port.onmessage = (ev) => {
                if (ev.data.type === 'audio' && ws?.readyState === WebSocket.OPEN) {
                    ws.send(ev.data.buffer);
                }
            };
            source.connect(workletNode);

            callStartTime = Date.now();
            durationInterval = setInterval(() => {
                if (els.metricDuration)
                    els.metricDuration.textContent = `${((Date.now() - callStartTime) / 1000).toFixed(1)}s`;
            }, 100);
        };

        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
                handleJsonMessage(JSON.parse(ev.data));
            } else if (ev.data instanceof ArrayBuffer) {
                handleBinaryMessage(ev.data);
            }
        };

        ws.onclose = () => stopLiveCall();
        ws.onerror = (e) => { console.error('WS error:', e); stopLiveCall(); };

    } catch (err) {
        console.error('startLiveCall failed:', err);
        alert('Could not start call: ' + err.message);
        stopLiveCall();
    }
}

function stopLiveCall() {
    isLiveCallActive = false;

    finalizeDownloadButton();
    stopAllAudio();

    if (ws)          { try { ws.close(); } catch (e) {} ws = null; }
    if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx)    { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }

    updateCallUI('idle');
}

// UI State
function updateCallUI(state) {
    if (!els.geminiOrb) return;
    els.geminiOrb.className = `orb-container ${state}`;

    const configs = {
        idle:       { btn: false, btnTxt: 'Start Live Conversation', icon: '🎙️', status: 'Ready to Talk' },
        connecting: { btn: true,  btnTxt: 'End Call',                icon: '⏳', status: 'Connecting...' },
        listening:  { btn: true,  btnTxt: 'End Call',                icon: '👂', status: 'Listening to you...' },
        thinking:   { btn: true,  btnTxt: 'End Call',                icon: '🧠', status: 'Vaani is thinking...' },
        speaking:   { btn: true,  btnTxt: 'End Call',                icon: '🔊', status: 'Vaani is speaking...' },
    };
    const c = configs[state] || configs.idle;
    els.btnLiveCall?.classList.toggle('active-call', c.btn);
    if (els.callBtnText)   els.callBtnText.textContent   = c.btnTxt;
    if (els.orbIcon)       els.orbIcon.textContent       = c.icon;
    if (els.orbStatusText) els.orbStatusText.textContent = c.status;
}

// Message Routing
function handleJsonMessage(msg) {
    switch (msg.type) {
        case 'ready':
            updateCallUI('listening');
            break;

        case 'state':
            updateCallUI(msg.state);
            if (msg.state === 'listening') {
                // Barge-in: stop playback immediately
                stopAllAudio();
                finalizeDownloadButton();
                activeAiBubble = null;
                activeAiBubbleText = '';
                turnWavBlobs = [];
            }
            break;

        case 'transcription':
            finalizeDownloadButton();
            appendChatBubble('user', msg.text);
            activeAiBubble = null;
            activeAiBubbleText = '';
            turnWavBlobs = [];
            expectingWavBlob = false;
            break;

        case 'ai_text':
            if (!activeAiBubble) {
                activeAiBubble = appendChatBubble('ai', '');
            }
            activeAiBubbleText += msg.text;
            const textEl = activeAiBubble.querySelector('.chat-text');
            if (textEl) textEl.textContent = activeAiBubbleText;
            scrollToBottom();
            break;

        case 'audio_wav':
            // The NEXT binary WebSocket message is a complete WAV file for this chunk
            expectingWavBlob = true;
            break;

        case 'metrics':
            if (msg.ttfa_ms && els.metricTTFA) {
                els.metricTTFA.textContent = `${Math.round(msg.ttfa_ms)} ms`;
            }
            break;

        case 'barge_in':
            stopAllAudio();
            if (els.metricBargeIn) {
                els.metricBargeIn.textContent = 'Interrupted!';
                setTimeout(() => {
                    if (els.metricBargeIn) els.metricBargeIn.textContent = 'Active (Ready)';
                }, 2000);
            }
            break;

        case 'error':
            console.error('Server error:', msg.message);
            break;
    }
}

// Binary = WAV Blob
function handleBinaryMessage(arrayBuffer) {
    if (!expectingWavBlob) {
        console.warn('Received unexpected binary message — ignoring');
        return;
    }
    expectingWavBlob = false;

    // Verify WAV magic bytes: "RIFF"
    const h = new Uint8Array(arrayBuffer, 0, Math.min(4, arrayBuffer.byteLength));
    if (h[0] !== 0x52 || h[1] !== 0x49 || h[2] !== 0x46 || h[3] !== 0x46) {
        console.error('Binary message is not a WAV file (bad magic bytes)');
        return;
    }

    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    turnWavBlobs.push(blob);
    enqueueWavBlob(blob);
}

// Audio Queue
function enqueueWavBlob(blob) {
    const url = URL.createObjectURL(blob);
    audioQueue.push(url);
    if (!isPlayingAudio) playNextInQueue();
}

function playNextInQueue() {
    if (audioQueue.length === 0) {
        isPlayingAudio = false;
        return;
    }

    isPlayingAudio = true;
    const url = audioQueue.shift();

    currentAudio = new Audio(url);
    currentAudio.volume = 1.0;

    currentAudio.onended = () => {
        URL.revokeObjectURL(url);
        currentAudio = null;
        playNextInQueue();
    };

    currentAudio.onerror = (e) => {
        console.error('Audio playback error:', e);
        URL.revokeObjectURL(url);
        currentAudio = null;
        playNextInQueue();
    };

    currentAudio.play().catch(err => {
        console.error('Audio.play() rejected:', err);
        URL.revokeObjectURL(url);
        currentAudio = null;
        playNextInQueue();
    });
}

function stopAllAudio() {
    audioQueue.forEach(u => URL.revokeObjectURL(u));
    audioQueue = [];
    isPlayingAudio = false;
    expectingWavBlob = false;

    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        try { currentAudio.pause(); } catch (_) {}
        currentAudio.src = '';
        currentAudio = null;
    }
}

// Per-Turn Download Button
function finalizeDownloadButton() {
    if (!activeAiBubble || turnWavBlobs.length === 0) return;
    const slot = activeAiBubble.querySelector('.audio-download-slot');
    if (!slot || slot.innerHTML.trim()) return;

    mergeWavBlobs(turnWavBlobs).then(mergedBlob => {
        const url = URL.createObjectURL(mergedBlob);
        slot.innerHTML = `
            <a href="${url}" download="vaani_response_${Date.now()}.wav" class="btn-download-wav">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download Audio (WAV)
            </a>`;
    });
    turnWavBlobs = [];
}

async function mergeWavBlobs(blobs) {
    const sampleRate = 24000;
    const pcmChunks = [];
    let totalPcmBytes = 0;

    for (const blob of blobs) {
        const buf = await blob.arrayBuffer();
        if (buf.byteLength <= 44) continue;
        const pcm = buf.slice(44);
        pcmChunks.push(pcm);
        totalPcmBytes += pcm.byteLength;
    }

    const out = new ArrayBuffer(44 + totalPcmBytes);
    const v = new DataView(out);
    const s = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };

    s(0,  'RIFF'); v.setUint32(4,  36 + totalPcmBytes, true);
    s(8,  'WAVE'); s(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, totalPcmBytes, true);

    let off = 44;
    const outBytes = new Uint8Array(out);
    for (const chunk of pcmChunks) { outBytes.set(new Uint8Array(chunk), off); off += chunk.byteLength; }

    return new Blob([out], { type: 'audio/wav' });
}

// Chat Bubbles
function appendChatBubble(sender, text) {
    const placeholder = els.transcriptFeed?.querySelector('.chat-placeholder');
    if (placeholder) placeholder.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${sender}`;
    bubble.innerHTML = `
        <span class="chat-sender">${sender === 'user' ? 'You' : 'Vaani'}</span>
        <span class="chat-text">${escHtml(text)}</span>
        <div class="audio-download-slot"></div>`;
    els.transcriptFeed?.appendChild(bubble);
    scrollToBottom();
    return bubble;
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function scrollToBottom() {
    if (els.transcriptFeed) els.transcriptFeed.scrollTop = els.transcriptFeed.scrollHeight;
}

// Boot
init();
