/**
 * 🎙️ VaaniAI — Browser Voice Client
 * WebSocket audio streaming, playback, waveform visualization, and UI management.
 */

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const CONFIG = {
    WS_URL: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/audio`,
    SAMPLE_RATE_IN: 16000,   // PCM sent to server
    SAMPLE_RATE_OUT: 24000,  // PCM received from server (TTS output)
    RECONNECT_DELAY: 3000,
    MAX_RECONNECT_ATTEMPTS: 5,
};

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const state = {
    ws: null,
    audioContext: null,
    workletNode: null,
    mediaStream: null,
    isConnected: false,
    isListening: false,
    pipelineState: 'idle',   // idle | listening | thinking | speaking
    reconnectAttempts: 0,
    playbackQueue: [],
    isPlaying: false,
    currentAiMessage: null,  // DOM element for streaming AI text
};

// ─────────────────────────────────────────────
// DOM Elements
// ─────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const elements = {
    voiceOrb: $('#voiceOrb'),
    orbContainer: $('#orbContainer'),
    orbLabel: $('#orbLabel'),
    orbGlow: $('#orbGlow'),
    micIcon: $('#micIcon'),
    stopIcon: $('#stopIcon'),
    connectionStatus: $('#connectionStatus'),
    statusDot: $('#statusDot'),
    statusText: $('#statusText'),
    transcriptMessages: $('#transcriptMessages'),
    waveformContainer: $('#waveformContainer'),
    waveformCanvas: $('#waveformCanvas'),
    btnSettings: $('#btnSettings'),
    btnCloseSettings: $('#btnCloseSettings'),
    btnClearChat: $('#btnClearChat'),
    settingsModal: $('#settingsModal'),
    inputMode: $('#inputMode'),
    serverUrl: $('#serverUrl'),
    metricTTFA: $('#metricTTFA'),
    metricSTT: $('#metricSTT'),
    metricLLM: $('#metricLLM'),
    metricTotal: $('#metricTotal'),
    metricBargeIn: $('#metricBargeIn'),
    particles: $('#particles'),
};

// ─────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initParticles();
    initEventListeners();
    elements.serverUrl.value = CONFIG.WS_URL;
});

function initEventListeners() {
    elements.voiceOrb.addEventListener('click', toggleVoice);
    elements.btnSettings.addEventListener('click', () => elements.settingsModal.classList.remove('hidden'));
    elements.btnCloseSettings.addEventListener('click', () => elements.settingsModal.classList.add('hidden'));
    elements.btnClearChat.addEventListener('click', clearChat);
    elements.settingsModal.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) elements.settingsModal.classList.add('hidden');
    });

    // Update server URL from settings
    elements.serverUrl.addEventListener('change', (e) => {
        CONFIG.WS_URL = e.target.value;
    });
}

// ─────────────────────────────────────────────
// Background Particles
// ─────────────────────────────────────────────
function initParticles() {
    const container = elements.particles;
    const count = 30;

    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';

        const size = Math.random() * 4 + 2;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.animationDuration = `${Math.random() * 20 + 15}s`;
        particle.style.animationDelay = `${Math.random() * 20}s`;

        container.appendChild(particle);
    }
}

// ─────────────────────────────────────────────
// Voice Toggle (Main Button)
// ─────────────────────────────────────────────
async function toggleVoice() {
    if (state.isListening) {
        stopListening();
    } else {
        await startListening();
    }
}

async function startListening() {
    try {
        // Get microphone permission
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
            },
        });

        // Create AudioContext
        state.audioContext = new AudioContext({ sampleRate: 48000 });

        // Load and register the AudioWorklet
        await state.audioContext.audioWorklet.addModule('audio-worklet.js');

        // Create worklet node
        state.workletNode = new AudioWorkletNode(state.audioContext, 'vaani-audio-processor', {
            processorOptions: { sampleRate: state.audioContext.sampleRate },
        });

        // Handle audio data from worklet
        state.workletNode.port.onmessage = (event) => {
            if (event.data.type === 'audio' && state.ws?.readyState === WebSocket.OPEN) {
                // Send raw PCM bytes to server
                state.ws.send(new Uint8Array(event.data.buffer));
            }
        };

        // Connect microphone → worklet
        const source = state.audioContext.createMediaStreamSource(state.mediaStream);
        source.connect(state.workletNode);
        // Don't connect worklet to destination (we don't want to hear our own mic)

        // Connect WebSocket
        connectWebSocket();

        state.isListening = true;
        updateUI('listening');
        elements.waveformContainer.classList.add('visible');

        // Start waveform visualization
        startWaveformVisualization(source);

    } catch (err) {
        console.error('Failed to start listening:', err);
        addSystemMessage('⚠️ Microphone access denied. Please allow microphone access and try again.');
    }
}

function stopListening() {
    // Stop media tracks
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(track => track.stop());
        state.mediaStream = null;
    }

    // Close audio context
    if (state.audioContext) {
        state.audioContext.close();
        state.audioContext = null;
    }

    // Disconnect WebSocket
    if (state.ws) {
        state.ws.send(JSON.stringify({ type: 'stop' }));
        state.ws.close();
        state.ws = null;
    }

    state.isListening = false;
    state.workletNode = null;
    state.playbackQueue = [];
    state.isPlaying = false;

    updateUI('idle');
    elements.waveformContainer.classList.remove('visible');
}

// ─────────────────────────────────────────────
// WebSocket Connection
// ─────────────────────────────────────────────
function connectWebSocket() {
    if (state.ws?.readyState === WebSocket.OPEN) return;

    const url = elements.serverUrl.value || CONFIG.WS_URL;
    state.ws = new WebSocket(url);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
        console.log('WebSocket connected');
        state.isConnected = true;
        state.reconnectAttempts = 0;
        setConnectionStatus(true);
    };

    state.ws.onclose = () => {
        console.log('WebSocket closed');
        state.isConnected = false;
        setConnectionStatus(false);

        // Auto-reconnect
        if (state.isListening && state.reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
            state.reconnectAttempts++;
            setTimeout(connectWebSocket, CONFIG.RECONNECT_DELAY);
        }
    };

    state.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };

    state.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            // Binary data = TTS audio
            handleAudioData(event.data);
        } else {
            // Text data = JSON control messages
            handleJsonMessage(JSON.parse(event.data));
        }
    };
}

// ─────────────────────────────────────────────
// Message Handlers
// ─────────────────────────────────────────────
function handleJsonMessage(msg) {
    switch (msg.type) {
        case 'ready':
            console.log('Pipeline ready:', msg.session_id);
            addSystemMessage('🟢 Connected! Start speaking...');
            break;

        case 'state':
            state.pipelineState = msg.state;
            updateUI(msg.state);
            break;

        case 'partial_transcription':
            updatePartialTranscription(msg.text);
            break;

        case 'transcription':
            addUserMessage(msg.text);
            clearPartialTranscription();
            if (msg.transcription_ms) {
                updateMetric('metricSTT', msg.transcription_ms);
            }
            break;

        case 'ai_text':
            appendAiText(msg.text);
            break;

        case 'metrics':
            if (msg.ttfa_ms) updateMetric('metricTTFA', msg.ttfa_ms);
            if (msg.total_ms) updateMetric('metricTotal', msg.total_ms);
            break;

        case 'barge_in':
            finalizeAiMessage('[interrupted]');
            updateMetric('metricBargeIn', parseInt(elements.metricBargeIn.textContent) + 1, true);
            break;

        case 'error':
            console.error('Pipeline error:', msg.message);
            addSystemMessage(`⚠️ ${msg.message}`);
            break;

        case 'pong':
            break;

        default:
            console.log('Unknown message:', msg);
    }
}

function handleAudioData(arrayBuffer) {
    // Queue audio for playback
    state.playbackQueue.push(arrayBuffer);

    if (!state.isPlaying) {
        playNextChunk();
    }
}

// ─────────────────────────────────────────────
// Audio Playback
// ─────────────────────────────────────────────
async function playNextChunk() {
    if (state.playbackQueue.length === 0) {
        state.isPlaying = false;
        return;
    }

    state.isPlaying = true;
    const buffer = state.playbackQueue.shift();

    try {
        // Convert Int16 PCM to Float32 for Web Audio
        const int16 = new Int16Array(buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }

        // Create AudioBuffer at TTS output sample rate
        const audioCtx = state.audioContext;
        if (!audioCtx || audioCtx.state === 'closed') {
            state.isPlaying = false;
            return;
        }

        const audioBuffer = audioCtx.createBuffer(1, float32.length, CONFIG.SAMPLE_RATE_OUT);
        audioBuffer.getChannelData(0).set(float32);

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);

        source.onended = () => {
            playNextChunk(); // Play next chunk seamlessly
        };

        source.start();

    } catch (err) {
        console.error('Playback error:', err);
        state.isPlaying = false;
        // Try next chunk
        if (state.playbackQueue.length > 0) {
            playNextChunk();
        }
    }
}

// ─────────────────────────────────────────────
// Waveform Visualization
// ─────────────────────────────────────────────
let animationFrameId = null;

function startWaveformVisualization(source) {
    const canvas = elements.waveformCanvas;
    const ctx = canvas.getContext('2d');
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 256;

    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    function draw() {
        animationFrameId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, width, height);

        const barWidth = (width / bufferLength) * 1.5;
        const centerY = height / 2;

        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * (height * 0.8);
            const x = i * (barWidth + 1);

            // Gradient color based on state
            let hue;
            switch (state.pipelineState) {
                case 'listening': hue = 160; break; // Green
                case 'thinking':  hue = 35;  break; // Amber
                case 'speaking':  hue = 260; break; // Purple
                default:          hue = 250; break; // Blue-purple
            }

            const alpha = 0.4 + (dataArray[i] / 255) * 0.6;
            ctx.fillStyle = `hsla(${hue}, 80%, 65%, ${alpha})`;

            // Draw mirrored bars from center
            ctx.fillRect(x, centerY - barHeight / 2, barWidth, barHeight / 2);
            ctx.fillRect(x, centerY, barWidth, barHeight / 2);
        }
    }

    draw();
}

// ─────────────────────────────────────────────
// UI Updates
// ─────────────────────────────────────────────
function updateUI(pipelineState) {
    const orbContainer = elements.orbContainer;
    const label = elements.orbLabel;

    // Remove all state classes
    orbContainer.classList.remove('idle', 'listening', 'thinking', 'speaking');

    switch (pipelineState) {
        case 'idle':
            orbContainer.classList.add('idle');
            label.textContent = state.isListening ? 'Ready — speak now' : 'Click to start';
            elements.micIcon.classList.remove('hidden');
            elements.stopIcon.classList.add('hidden');
            break;

        case 'listening':
            orbContainer.classList.add('listening');
            label.textContent = 'Listening...';
            elements.micIcon.classList.remove('hidden');
            elements.stopIcon.classList.add('hidden');
            break;

        case 'thinking':
            orbContainer.classList.add('thinking');
            label.textContent = 'Thinking...';
            elements.micIcon.classList.add('hidden');
            elements.stopIcon.classList.remove('hidden');
            break;

        case 'speaking':
            orbContainer.classList.add('speaking');
            label.textContent = 'Speaking...';
            elements.micIcon.classList.add('hidden');
            elements.stopIcon.classList.remove('hidden');
            break;
    }
}

function setConnectionStatus(connected) {
    const dot = elements.statusDot;
    const text = elements.statusText;

    if (connected) {
        dot.classList.add('connected');
        text.textContent = 'Connected';
    } else {
        dot.classList.remove('connected');
        text.textContent = 'Disconnected';
    }
}

// ─────────────────────────────────────────────
// Transcript Management
// ─────────────────────────────────────────────
function addUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'message user-message';
    div.innerHTML = `<div class="message-content"><p>${escapeHtml(text)}</p></div>`;
    elements.transcriptMessages.appendChild(div);
    scrollToBottom();
}

function appendAiText(text) {
    if (!state.currentAiMessage) {
        // Start a new AI message
        const div = document.createElement('div');
        div.className = 'message ai-message';
        div.innerHTML = `<div class="message-content"><p></p></div>`;
        elements.transcriptMessages.appendChild(div);
        state.currentAiMessage = div.querySelector('p');
    }

    state.currentAiMessage.textContent += text + ' ';
    scrollToBottom();
}

function finalizeAiMessage(suffix = '') {
    if (state.currentAiMessage) {
        if (suffix) {
            const span = document.createElement('span');
            span.style.color = 'var(--text-muted)';
            span.style.fontStyle = 'italic';
            span.textContent = ` ${suffix}`;
            state.currentAiMessage.appendChild(span);
        }
        state.currentAiMessage = null;
    }
}

function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.innerHTML = `<div class="message-content"><p>${text}</p></div>`;
    elements.transcriptMessages.appendChild(div);
    scrollToBottom();
}

let partialElement = null;

function updatePartialTranscription(text) {
    if (!partialElement) {
        partialElement = document.createElement('div');
        partialElement.className = 'partial-text';
        elements.transcriptMessages.appendChild(partialElement);
    }
    partialElement.textContent = `🎤 ${text}`;
    scrollToBottom();
}

function clearPartialTranscription() {
    if (partialElement) {
        partialElement.remove();
        partialElement = null;
    }
}

function clearChat() {
    elements.transcriptMessages.innerHTML = '';
    addSystemMessage('Conversation cleared. Start speaking!');

    // Reset on server too
    if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'reset' }));
    }
}

function scrollToBottom() {
    elements.transcriptMessages.scrollTop = elements.transcriptMessages.scrollHeight;
}

// ─────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────
function updateMetric(metricId, value, isCount = false) {
    const el = elements[metricId];
    if (!el) return;

    if (isCount) {
        el.textContent = value;
        return;
    }

    const ms = Math.round(value);
    el.textContent = `${ms}ms`;

    // Color coding
    el.classList.remove('good', 'warn', 'bad');
    if (ms < 300) {
        el.classList.add('good');
    } else if (ms < 600) {
        el.classList.add('warn');
    } else {
        el.classList.add('bad');
    }
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Keep-alive ping
setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 15000);

// Finalize AI message when state returns to idle
const originalUpdateUI = updateUI;
updateUI = function(pipelineState) {
    if (pipelineState === 'idle' || pipelineState === 'listening') {
        finalizeAiMessage();
    }
    originalUpdateUI(pipelineState);
};
