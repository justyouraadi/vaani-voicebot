/**
 * 🎙️ VaaniAI — Real-Time Gemini Live Agent Engine
 */

const API_BASE = window.location.origin + '/api';

// DOM Elements
const els = {
    serverStatus: document.getElementById('serverStatusText'),
    
    // Gemini Live Agent Elements
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
let audioQueue = [];
let isPlayingAudio = false;
let currentSourceNode = null;
let activeAiBubbleText = null;
let activeAiBubble = null;

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
        appendChatBubble('user', msg.text);
        activeAiBubble = null;
        activeAiBubbleText = "";
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
    `;
    els.transcriptFeed.appendChild(bubble);
    scrollTranscriptToBottom();
    return bubble;
}

function scrollTranscriptToBottom() {
    els.transcriptFeed.scrollTop = els.transcriptFeed.scrollHeight;
}

// ─────────────────────────────────────────────
// Audio Chunk Playback (24kHz PCM Int16)
// ─────────────────────────────────────────────

function handleAudioChunk(arrayBuffer) {
    if (!audioCtx) return;

    // Convert Int16 PCM arraybuffer to Float32 [-1, 1]
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 32768 : 32767);
    }

    // Create Audio Buffer at 24kHz (XTTS output sample rate)
    const buffer = audioCtx.createBuffer(1, float32Array.length, 24000);
    buffer.getChannelData(0).set(float32Array);

    audioQueue.push(buffer);
    if (!isPlayingAudio) {
        playNextAudioInQueue();
    }
}

function playNextAudioInQueue() {
    if (audioQueue.length === 0) {
        isPlayingAudio = false;
        return;
    }

    isPlayingAudio = true;
    const buffer = audioQueue.shift();
    
    currentSourceNode = audioCtx.createBufferSource();
    currentSourceNode.buffer = buffer;
    currentSourceNode.connect(audioCtx.destination);
    
    currentSourceNode.onended = () => {
        playNextAudioInQueue();
    };

    currentSourceNode.start(0);
}

function stopAllAudioPlayback() {
    audioQueue = [];
    isPlayingAudio = false;
    if (currentSourceNode) {
        try { currentSourceNode.stop(); } catch(e){}
        currentSourceNode = null;
    }
}

// Run
init();
