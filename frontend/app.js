/**
 * 🎙️ VaaniAI — Gemini Live Agent & Voice Studio Engine
 */

const API_BASE = window.location.origin + '/api';

// DOM Elements
const els = {
    serverStatus: document.getElementById('serverStatusText'),
    
    // Navigation Tabs
    tabLiveAgent: document.getElementById('tabLiveAgent'),
    tabVoiceStudio: document.getElementById('tabVoiceStudio'),
    liveAgentView: document.getElementById('liveAgentView'),
    voiceStudioView: document.getElementById('voiceStudioView'),

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

    // Voice Studio Elements
    voiceList: document.getElementById('voiceList'),
    voiceCount: document.getElementById('voiceCount'),
    voiceSelect: document.getElementById('voiceSelect'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    btnRecord: document.getElementById('btnRecord'),
    recordText: document.getElementById('recordText'),
    uploadProgress: document.getElementById('uploadProgress'),
    
    // Synthesis Form
    textInput: document.getElementById('textInput'),
    languageSelect: document.getElementById('languageSelect'),
    emotionSelect: document.getElementById('emotionSelect'),
    speedSlider: document.getElementById('speedSlider'),
    stabilitySlider: document.getElementById('stabilitySlider'),
    similaritySlider: document.getElementById('similaritySlider'),
    speedVal: document.getElementById('speedVal'),
    stabilityVal: document.getElementById('stabilityVal'),
    similarityVal: document.getElementById('similarityVal'),
    btnGenerate: document.getElementById('btnGenerate'),
    generateBtnText: document.getElementById('generateBtnText'),
    generateBtnIcon: document.getElementById('generateBtnIcon'),
    generateSpinner: document.getElementById('generateSpinner'),
    
    // Result
    resultContainer: document.getElementById('resultContainer'),
    genTime: document.getElementById('genTime'),
    audioPlayer: document.getElementById('audioPlayer'),
    downloadBtn: document.getElementById('downloadBtn')
};

// State Variables
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

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
    setupTabNavigation();
    await fetchVoices();
    setupStudioEventListeners();
    setupLiveAgentEventListeners();
}

// Tab Navigation
function setupTabNavigation() {
    els.tabLiveAgent.addEventListener('click', () => switchTab('liveAgent'));
    els.tabVoiceStudio.addEventListener('click', () => switchTab('voiceStudio'));
}

function switchTab(tabName) {
    if (tabName === 'liveAgent') {
        els.tabLiveAgent.classList.add('active');
        els.tabVoiceStudio.classList.remove('active');
        els.liveAgentView.classList.remove('hidden');
        els.voiceStudioView.classList.add('hidden');
    } else {
        els.tabVoiceStudio.classList.add('active');
        els.tabLiveAgent.classList.remove('active');
        els.voiceStudioView.classList.remove('hidden');
        els.liveAgentView.classList.add('hidden');
    }
}

// Fetch Voices from Backend
async function fetchVoices() {
    try {
        const response = await fetch(`${API_BASE}/voices`);
        if (!response.ok) throw new Error('Failed to fetch voices');
        
        const data = await response.json();
        const voices = data.voices || [];
        
        els.voiceCount.textContent = `${voices.length} Voices`;
        
        // Clear lists
        els.voiceList.innerHTML = '';
        els.voiceSelect.innerHTML = '';
        els.liveVoiceSelect.innerHTML = '';
        
        if (voices.length === 0) {
            els.voiceList.innerHTML = '<li class="voice-item"><div class="voice-name">No voices found</div></li>';
            els.voiceSelect.innerHTML = '<option value="" disabled selected>No voices available</option>';
            els.liveVoiceSelect.innerHTML = '<option value="" disabled selected>No voices available</option>';
            return;
        }

        voices.forEach((voice, index) => {
            // Add to Voice Studio List
            const li = document.createElement('li');
            li.className = `voice-item ${index === 0 ? 'active' : ''}`;
            const sizeKb = (voice.size_bytes / 1024).toFixed(1);
            li.innerHTML = `
                <div class="voice-info" style="flex: 1;" onclick="selectVoice(this, '${voice.filename}')">
                    <span class="voice-name">${voice.name}</span>
                    <span class="voice-size">${sizeKb} KB</span>
                </div>
                <button class="btn-delete" onclick="deleteVoice('${voice.filename}')" title="Delete Voice">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            `;
            els.voiceList.appendChild(li);
            
            // Add to Studio Dropdown
            const option = document.createElement('option');
            option.value = voice.filename;
            option.textContent = voice.name;
            if (index === 0) option.selected = true;
            els.voiceSelect.appendChild(option);

            // Add to Live Agent Dropdown
            const liveOpt = document.createElement('option');
            liveOpt.value = voice.filename;
            liveOpt.textContent = voice.name;
            if (index === 0) liveOpt.selected = true;
            els.liveVoiceSelect.appendChild(liveOpt);
        });
        
    } catch (error) {
        console.error('Error fetching voices:', error);
        els.voiceList.innerHTML = '<li class="voice-item"><div class="voice-name text-danger">Error loading voices</div></li>';
        els.serverStatus.textContent = 'Disconnected';
        els.serverStatus.previousElementSibling.classList.remove('online');
    }
}

// Select Voice in Library
window.selectVoice = function(element, filename) {
    document.querySelectorAll('.voice-item').forEach(el => el.classList.remove('active'));
    element.parentElement.classList.add('active');
    els.voiceSelect.value = filename;
    els.liveVoiceSelect.value = filename;
};

// Delete Voice
window.deleteVoice = async function(filename) {
    if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
    
    try {
        const response = await fetch(`${API_BASE}/voices/${filename}`, { method: 'DELETE' });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Delete failed');
        }
        await fetchVoices();
    } catch (error) {
        alert('Error deleting voice: ' + error.message);
    }
};

// ─────────────────────────────────────────────
// 🎙️ GEMINI LIVE AGENT WEBSOCKET ENGINE
// ─────────────────────────────────────────────

function setupLiveAgentEventListeners() {
    els.btnLiveCall.addEventListener('click', toggleLiveCall);
    els.btnClearTranscript.addEventListener('click', () => {
        els.transcriptFeed.innerHTML = `
            <div class="chat-placeholder">
                <p>Click <strong>"Start Live Conversation"</strong> and begin speaking. Vaani will listen, transcribe, and respond instantly with low latency.</p>
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
            workletNode.connect(audioCtx.destination); // Required to keep worklet alive

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
    // Remove placeholder
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

// ─────────────────────────────────────────────
// VOICE STUDIO (VOICE CLONER) LOGIC
// ─────────────────────────────────────────────

function setupStudioEventListeners() {
    els.btnGenerate.addEventListener('click', generateSpeech);
    els.speedSlider.addEventListener('input', (e) => els.speedVal.textContent = e.target.value + 'x');
    els.stabilitySlider.addEventListener('input', (e) => els.stabilityVal.textContent = e.target.value + '%');
    els.similaritySlider.addEventListener('input', (e) => els.similarityVal.textContent = e.target.value + '%');
    
    els.emotionSelect.addEventListener('change', (e) => {
        const em = e.target.value;
        if (em === 'excited') {
            els.speedSlider.value = 1.15;
            els.stabilitySlider.value = 20;
            els.similaritySlider.value = 40;
        } else if (em === 'sad') {
            els.speedSlider.value = 0.85;
            els.stabilitySlider.value = 80;
            els.similaritySlider.value = 60;
        } else if (em === 'angry') {
            els.speedSlider.value = 1.25;
            els.stabilitySlider.value = 10;
            els.similaritySlider.value = 30;
        } else {
            els.speedSlider.value = 1.0;
            els.stabilitySlider.value = 50;
            els.similaritySlider.value = 50;
        }
        els.speedVal.textContent = els.speedSlider.value + 'x';
        els.stabilityVal.textContent = els.stabilitySlider.value + '%';
        els.similarityVal.textContent = els.similaritySlider.value + '%';
    });
    
    els.dropzone.addEventListener('click', () => els.fileInput.click());
    els.dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        els.dropzone.classList.add('dragover');
    });
    els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
    els.dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        els.dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            uploadVoice(e.dataTransfer.files[0]);
        }
    });
    els.fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            uploadVoice(e.target.files[0]);
        }
    });
    
    els.btnRecord.addEventListener('click', toggleRecording);
}

async function uploadVoice(file) {
    if (!file) return;
    const formData = new FormData();
    const filename = file.name || `recording_${Date.now()}.webm`;
    formData.append('file', file, filename);
    
    els.uploadProgress.classList.remove('hidden');
    try {
        const response = await fetch(`${API_BASE}/voices`, { method: 'POST', body: formData });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Upload failed');
        }
        await fetchVoices();
    } catch (error) {
        alert('Error uploading voice: ' + error.message);
    } finally {
        els.uploadProgress.classList.add('hidden');
    }
}

async function generateSpeech() {
    let text = els.textInput.value.trim();
    const voice = els.voiceSelect.value;
    const language = els.languageSelect.value;
    const emotion = els.emotionSelect.value;
    let speed = parseFloat(els.speedSlider.value);
    
    const stabVal = parseInt(els.stabilitySlider.value, 10);
    const simVal = parseInt(els.similaritySlider.value, 10);
    
    const temp = 0.85 - (stabVal / 100) * 0.65;
    const top_p = 0.95 - (stabVal / 100) * 0.45;
    const top_k = Math.round(50 - (stabVal / 100) * 30);
    const rep_pen = 2.0 + (simVal / 100) * 8.0;
    const len_pen = 1.0 + (simVal / 100) * 1.0;
    
    if (!text) { alert("Please enter text."); return; }
    if (!voice) { alert("Please select a voice."); return; }
    
    if (emotion === 'excited' && !text.endsWith('!')) text += '!';
    else if (emotion === 'angry') text = text.toUpperCase() + '!!';
    else if (emotion === 'sad' && !text.endsWith('.')) text += '...';
    
    els.btnGenerate.disabled = true;
    els.generateBtnText.textContent = "Synthesizing...";
    els.generateBtnIcon.classList.add('hidden');
    els.generateSpinner.classList.remove('hidden');
    els.resultContainer.classList.add('hidden');
    
    const startTime = performance.now();
    
    try {
        const response = await fetch(`${API_BASE}/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text, voice, language, speed, temperature: temp, top_p, top_k,
                repetition_penalty: rep_pen, length_penalty: len_pen, stream: false
            })
        });
        
        if (!response.ok) throw new Error('Synthesis failed');
        
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        
        els.audioPlayer.src = audioUrl;
        els.downloadBtn.href = audioUrl;
        els.downloadBtn.download = `vaani_${voice}_${Date.now()}.wav`;
        
        const timeTaken = ((performance.now() - startTime) / 1000).toFixed(1);
        els.genTime.textContent = `${timeTaken}s generation time`;
        els.resultContainer.classList.remove('hidden');
        els.audioPlayer.play();
        
    } catch (error) {
        alert("Error generating speech: " + error.message);
    } finally {
        els.btnGenerate.disabled = false;
        els.generateBtnText.textContent = "Generate Speech";
        els.generateBtnIcon.classList.remove('hidden');
        els.generateSpinner.classList.add('hidden');
    }
}

async function toggleRecording() {
    if (!isRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                uploadVoice(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };
            
            mediaRecorder.start();
            isRecording = true;
            els.btnRecord.classList.add('recording');
            els.recordText.textContent = "Stop Recording";
        } catch (err) {
            alert("Microphone error: " + err.message);
        }
    } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        isRecording = false;
        els.btnRecord.classList.remove('recording');
        els.recordText.textContent = "Record Live Audio";
    }
}

// Run
init();
