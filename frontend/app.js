/**
 * 🎙️ VaaniAI — Real-Time Gemini Live Agent Engine
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

// Gemini Live Call State
let isLiveCallActive = false;
let ws = null;
let audioCtx = null;
let micStream = null;
let workletNode = null;
let callStartTime = null;
let durationInterval = null;

// Audio Streaming & Web Audio Clock Scheduler
let nextStartTime = 0;
let activeSourceNodes = [];
let pendingByteQueue = new Uint8Array(0);

// Per-Turn Audio Accumulator (for WAV download)
let turnInt16Samples = [];
let activeAiBubble = null;
let activeAiBubbleText = "";

// Initialize
async function init() {
    await fetchVoices();
    setupLiveAgentEventListeners();
}

// Fetch Voices from Backend
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
            const liveOpt = document.createElement('option');
            liveOpt.value = voice.filename;
            liveOpt.textContent = voice.name;
            if (index === 0) liveOpt.selected = true;
            els.liveVoiceSelect.appendChild(liveOpt);
        });
        
    } catch (error) {
        console.error('Error fetching voices:', error);
        els.serverStatus.textContent = 'Disconnected';
        els.serverStatus.previousElementSibling.classList.remove('online');
    }
}

// ─────────────────────────────────────────────
// 🎙️ GEMINI LIVE AGENT WEBSOCKET ENGINE
// ─────────────────────────────────────────────

function setupLiveAgentEventListeners() {
    els.btnLiveCall.addEventListener('click', toggleLiveCall);
    els.btnClearTranscript.addEventListener('click', () => {
        els.transcriptFeed.innerHTML = `
            <div class="chat-placeholder">
                <p>Click <strong>"Start Live Conversation"</strong> and speak into your microphone. Your transcript and Vaani's real-time voice response will stream here live.</p>
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
        // Init Web Audio Context
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await audioCtx.audioWorklet.addModule('/audio-worklet.js');

        // Request Mic Access
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // Setup WebSocket
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/ws/audio`;
        
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('Gemini Live WebSocket connected');
            isLiveCallActive = true;
            updateCallUI('connecting');
            
            // Start streaming mic audio
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

            // Start Duration Timer
            callStartTime = Date.now();
            durationInterval = setInterval(() => {
                const seconds = ((Date.now() - callStartTime) / 1000).toFixed(1);
                els.metricDuration.textContent = `${seconds}s`;
            }, 100);
        };

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                handleJsonMessage(JSON.parse(event.data));
            } else if (event.data instanceof ArrayBuffer) {
                handleAudioChunk(event.data);
            }
        };

        ws.onclose = () => {
            console.log('Gemini Live WebSocket closed');
            stopLiveCall();
        };

        ws.onerror = (err) => {
            console.error('WebSocket Error:', err);
            stopLiveCall();
        };

    } catch (err) {
        alert("Failed to start live call: " + err.message);
        stopLiveCall();
    }
}

function stopLiveCall() {
    isLiveCallActive = false;
    
    if (ws) {
        try { ws.close(); } catch(e){}
        ws = null;
    }

    if (workletNode) {
        try { workletNode.disconnect(); } catch(e){}
        workletNode = null;
    }

    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }

    if (audioCtx) {
        try { audioCtx.close(); } catch(e){}
        audioCtx = null;
    }

    if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
    }

    finalizeCurrentTurnAudio();
    stopAllAudioPlayback();
    updateCallUI('idle');
}

function updateCallUI(state) {
    els.geminiOrb.className = `orb-container ${state}`;
    
    if (state === 'idle') {
        els.btnLiveCall.classList.remove('active-call');
        els.callBtnText.textContent = "Start Live Conversation";
        els.orbIcon.textContent = "🎙️";
        els.orbStatusText.textContent = "Ready to Talk";
        els.metricBargeIn.textContent = "Active (Ready)";
        finalizeCurrentTurnAudio();
    } else if (state === 'connecting') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = "End Call";
        els.orbIcon.textContent = "⏳";
        els.orbStatusText.textContent = "Connecting...";
    } else if (state === 'listening') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = "End Call";
        els.orbIcon.textContent = "👂";
        els.orbStatusText.textContent = "Listening to you...";
        finalizeCurrentTurnAudio();
    } else if (state === 'thinking') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = "End Call";
        els.orbIcon.textContent = "🧠";
        els.orbStatusText.textContent = "Thinking...";
    } else if (state === 'speaking') {
        els.btnLiveCall.classList.add('active-call');
        els.callBtnText.textContent = "End Call";
        els.orbIcon.textContent = "🔊";
        els.orbStatusText.textContent = "Vaani is speaking...";
    }
}

// Handle Incoming Server Events
function handleJsonMessage(msg) {
    console.log("Server Msg:", msg);
    
    if (msg.type === 'ready') {
        updateCallUI('listening');
    } else if (msg.type === 'state') {
        updateCallUI(msg.state);
    } else if (msg.type === 'transcription') {
        finalizeCurrentTurnAudio();
        appendChatBubble('user', msg.text);
        activeAiBubble = null;
        activeAiBubbleText = "";
        turnInt16Samples = [];
    } else if (msg.type === 'ai_text') {
        if (!activeAiBubble) {
            activeAiBubble = appendChatBubble('ai', '');
            activeAiBubbleText = "";
        }
        activeAiBubbleText += msg.text;
        activeAiBubble.querySelector('.chat-text').textContent = activeAiBubbleText;
        scrollTranscriptToBottom();
    } else if (msg.type === 'metrics') {
        if (msg.ttfa_ms) {
            els.metricTTFA.textContent = `${msg.ttfa_ms} ms`;
        }
    } else if (msg.type === 'barge_in') {
        console.log("🛑 BARGE-IN DETECTED: Cutting audio playback immediately");
        stopAllAudioPlayback();
        finalizeCurrentTurnAudio();
        els.metricBargeIn.textContent = "Interrupted!";
        setTimeout(() => els.metricBargeIn.textContent = "Active (Ready)", 2000);
    }
}

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
    scrollTranscriptToBottom();
    return bubble;
}

function scrollTranscriptToBottom() {
    els.transcriptFeed.scrollTop = els.transcriptFeed.scrollHeight;
}

// Finalize AI Audio Turn into Downloadable WAV File
function finalizeCurrentTurnAudio() {
    if (activeAiBubble && turnInt16Samples.length > 0) {
        const slot = activeAiBubble.querySelector('.audio-download-slot');
        if (slot && !slot.innerHTML) {
            // Flatten Int16 samples
            const totalLen = turnInt16Samples.reduce((sum, chunk) => sum + chunk.length, 0);
            const mergedInt16 = new Int16Array(totalLen);
            let offset = 0;
            for (const chunk of turnInt16Samples) {
                mergedInt16.set(chunk, offset);
                offset += chunk.length;
            }

            const wavBlob = createWavBlob(mergedInt16, 24000);
            const wavUrl = URL.createObjectURL(wavBlob);

            slot.innerHTML = `
                <a href="${wavUrl}" download="vaani_response_${Date.now()}.wav" class="btn-download-wav" title="Download Response Audio">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    <span>Download Audio (WAV)</span>
                </a>
            `;
        }
    }
    turnInt16Samples = [];
}

// ─────────────────────────────────────────────
// Audio Chunk Processing & Web Audio Scheduler
// ─────────────────────────────────────────────

function handleAudioChunk(arrayBuffer) {
    if (!audioCtx) return;

    // 1. Accumulate raw bytes into byte queue
    const incomingBytes = new Uint8Array(arrayBuffer);
    const newByteQueue = new Uint8Array(pendingByteQueue.length + incomingBytes.length);
    newByteQueue.set(pendingByteQueue, 0);
    newByteQueue.set(incomingBytes, pendingByteQueue.length);

    // 2. Extract ONLY complete 2-byte (16-bit Int16) PCM samples
    const evenByteLength = Math.floor(newByteQueue.length / 2) * 2;
    if (evenByteLength === 0) {
        pendingByteQueue = newByteQueue;
        return;
    }

    const completeBytes = newByteQueue.subarray(0, evenByteLength);
    pendingByteQueue = newByteQueue.subarray(evenByteLength); // Hold remaining odd byte

    // 3. Convert Int16 PCM arraybuffer to Float32 [-1, 1]
    const int16Array = new Int16Array(completeBytes.buffer, completeBytes.byteOffset, completeBytes.length / 2);
    
    // Collect samples for downloadable WAV
    turnInt16Samples.push(new Int16Array(int16Array));

    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 32768 : 32767);
    }

    // 4. Create Audio Buffer at 24kHz (XTTS output sample rate)
    const audioBuffer = audioCtx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);

    // 5. Schedule buffer on Web Audio Clock (Gapless, Sample-Accurate)
    scheduleAudioBuffer(audioBuffer);
}

function scheduleAudioBuffer(buffer) {
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    // Jitter buffer of 40ms for smooth continuous streaming
    if (nextStartTime < now) {
        nextStartTime = now + 0.04;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(nextStartTime);

    nextStartTime += buffer.duration;
    activeSourceNodes.push(source);

    source.onended = () => {
        const idx = activeSourceNodes.indexOf(source);
        if (idx > -1) activeSourceNodes.splice(idx, 1);
    };
}

function stopAllAudioPlayback() {
    activeSourceNodes.forEach(node => {
        try { node.stop(); } catch(e){}
    });
    activeSourceNodes = [];
    nextStartTime = 0;
    pendingByteQueue = new Uint8Array(0);
}

// ─────────────────────────────────────────────
// WAV Blob Generator Utility
// ─────────────────────────────────────────────

function createWavBlob(int16Samples, sampleRate = 24000) {
    const buffer = new ArrayBuffer(44 + int16Samples.length * 2);
    const view = new DataView(buffer);

    /* RIFF identifier */
    writeString(view, 0, 'RIFF');
    /* RIFF chunk length */
    view.setUint32(4, 36 + int16Samples.length * 2, true);
    /* RIFF type */
    writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw PCM) */
    view.setUint16(20, 1, true);
    /* channel count (mono) */
    view.setUint16(22, 1, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sampleRate * 2) */
    view.setUint32(28, sampleRate * 2, true);
    /* block align */
    view.setUint16(32, 2, true);
    /* bits per sample */
    view.setUint16(34, 16, true);
    /* data chunk identifier */
    writeString(view, 36, 'data');
    /* data chunk length */
    view.setUint32(40, int16Samples.length * 2, true);

    // Write samples
    let offset = 44;
    for (let i = 0; i < int16Samples.length; i++, offset += 2) {
        view.setInt16(offset, int16Samples[i], true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Run
init();
