/**
 * 🎙️ VaaniAI Voice Studio Logic
 */

const API_BASE = window.location.origin + '/api';

// DOM Elements
const els = {
    serverStatus: document.getElementById('serverStatusText'),
    voiceList: document.getElementById('voiceList'),
    voiceCount: document.getElementById('voiceCount'),
    voiceSelect: document.getElementById('voiceSelect'),
    
    // Upload & Record
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    btnRecord: document.getElementById('btnRecord'),
    recordText: document.getElementById('recordText'),
    uploadProgress: document.getElementById('uploadProgress'),
    
    // Synthesis
    textInput: document.getElementById('textInput'),
    voiceSelect: document.getElementById('voiceSelect'),
    languageSelect: document.getElementById('languageSelect'),
    emotionSelect: document.getElementById('emotionSelect'),
    speedSlider: document.getElementById('speedSlider'),
    tempSlider: document.getElementById('tempSlider'),
    speedVal: document.getElementById('speedVal'),
    tempVal: document.getElementById('tempVal'),
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

let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

// Initialize
async function init() {
    await fetchVoices();
    setupEventListeners();
}

// Fetch Voices from Backend
async function fetchVoices() {
    try {
        const response = await fetch(`${API_BASE}/voices`);
        if (!response.ok) throw new Error('Failed to fetch voices');
        
        const data = await response.json();
        const voices = data.voices || [];
        
        els.voiceCount.textContent = `${voices.length} Voices`;
        
        // Populate List
        els.voiceList.innerHTML = '';
        els.voiceSelect.innerHTML = '';
        
        if (voices.length === 0) {
            els.voiceList.innerHTML = '<li class="voice-item"><div class="voice-name">No voices found</div></li>';
            els.voiceSelect.innerHTML = '<option value="" disabled selected>No voices available</option>';
            return;
        }

        voices.forEach((voice, index) => {
            // Add to Left Panel List
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
            
            // Add to Dropdown
            const option = document.createElement('option');
            option.value = voice.filename;
            option.textContent = voice.name;
            if (index === 0) option.selected = true;
            els.voiceSelect.appendChild(option);
        });
        
    } catch (error) {
        console.error('Error fetching voices:', error);
        els.voiceList.innerHTML = '<li class="voice-item"><div class="voice-name text-danger">Error loading voices</div></li>';
        els.serverStatus.textContent = 'Disconnected';
        els.serverStatus.previousElementSibling.classList.remove('online');
    }
}

// UI Helpers
window.selectVoice = function(element, filename) {
    document.querySelectorAll('.voice-item').forEach(el => el.classList.remove('active'));
    element.parentElement.classList.add('active');
    els.voiceSelect.value = filename;
};

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

// Upload Audio File
async function uploadVoice(file) {
    if (!file) return;
    
    const formData = new FormData();
    // Use the original filename or a timestamp if it's a blob
    const filename = file.name || `recording_${Date.now()}.webm`;
    formData.append('file', file, filename);
    
    els.uploadProgress.classList.remove('hidden');
    
    try {
        const response = await fetch(`${API_BASE}/voices`, {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Upload failed');
        }
        
        // Refresh voices list to show the new voice
        await fetchVoices();
        
        // Select the newly uploaded voice
        const newVoiceData = await response.json().catch(()=>({}));
        if(newVoiceData && newVoiceData.filename) {
            els.voiceSelect.value = newVoiceData.filename;
        }
        
    } catch (error) {
        alert('Error uploading voice: ' + error.message);
        console.error(error);
    } finally {
        els.uploadProgress.classList.add('hidden');
    }
}

// Synthesize Speech
async function generateSpeech() {
    let text = els.textInput.value.trim();
    const voice = els.voiceSelect.value;
    const language = els.languageSelect.value;
    const emotion = els.emotionSelect.value;
    let speed = parseFloat(els.speedSlider.value);
    let temp = parseFloat(els.tempSlider.value);
    
    if (!text) {
        alert("Please enter some text to synthesize.");
        return;
    }
    if (!voice) {
        alert("Please select a voice from the library.");
        return;
    }
    
    // Emotion Text Prosody Processing
    // XTTS v2 responds well to punctuation
    if (emotion === 'excited') {
        if (!text.endsWith('!') && !text.endsWith('?')) text += '!';
    } else if (emotion === 'angry') {
        text = text.toUpperCase();
        if (!text.endsWith('!') && !text.endsWith('?')) text += '!!';
    } else if (emotion === 'sad') {
        if (!text.endsWith('.') && !text.endsWith('?')) text += '...';
    }
    
    // Set UI to loading state
    els.btnGenerate.disabled = true;
    els.generateBtnText.textContent = "Synthesizing...";
    els.generateBtnIcon.classList.add('hidden');
    els.generateSpinner.classList.remove('hidden');
    els.resultContainer.classList.add('hidden');
    
    const startTime = performance.now();
    
    try {
        const response = await fetch(`${API_BASE}/synthesize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                voice: voice,
                language: language,
                speed: speed,
                temperature: temp,
                stream: false // Request a full WAV file back
            })
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(()=>({}));
            throw new Error(errData.detail || 'Synthesis failed');
        }
        
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        
        // Update Player
        els.audioPlayer.src = audioUrl;
        els.downloadBtn.href = audioUrl;
        els.downloadBtn.download = `vaani_${voice}_${Date.now()}.wav`;
        
        // Show result
        const timeTaken = ((performance.now() - startTime) / 1000).toFixed(1);
        els.genTime.textContent = `${timeTaken}s generation time`;
        els.resultContainer.classList.remove('hidden');
        
        // Auto-play
        els.audioPlayer.play();
        
    } catch (error) {
        alert("Error generating speech: " + error.message);
        console.error(error);
    } finally {
        // Reset UI
        els.btnGenerate.disabled = false;
        els.generateBtnText.textContent = "Generate Speech";
        els.generateBtnIcon.classList.remove('hidden');
        els.generateSpinner.classList.add('hidden');
    }
}

// Event Listeners
function setupEventListeners() {
    // Generate Button
    els.btnGenerate.addEventListener('click', generateSpeech);
    
    // Sliders
    els.speedSlider.addEventListener('input', (e) => els.speedVal.textContent = e.target.value);
    els.tempSlider.addEventListener('input', (e) => els.tempVal.textContent = e.target.value);
    
    // Emotion Presets
    els.emotionSelect.addEventListener('change', (e) => {
        const em = e.target.value;
        if (em === 'excited') {
            els.speedSlider.value = 1.15;
            els.tempSlider.value = 0.85;
        } else if (em === 'sad') {
            els.speedSlider.value = 0.85;
            els.tempSlider.value = 0.65;
        } else if (em === 'angry') {
            els.speedSlider.value = 1.25;
            els.tempSlider.value = 0.9;
        } else {
            // Neutral
            els.speedSlider.value = 1.0;
            els.tempSlider.value = 0.75;
        }
        els.speedVal.textContent = els.speedSlider.value;
        els.tempVal.textContent = els.tempSlider.value;
    });
    
    // Drag & Drop
    els.dropzone.addEventListener('click', () => els.fileInput.click());
    
    els.dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        els.dropzone.classList.add('dragover');
    });
    
    els.dropzone.addEventListener('dragleave', () => {
        els.dropzone.classList.remove('dragover');
    });
    
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
    
    // Live Recording
    els.btnRecord.addEventListener('click', toggleRecording);
}

async function toggleRecording() {
    if (!isRecording) {
        // Start recording
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };
            
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                uploadVoice(audioBlob);
                
                // Stop all tracks
                stream.getTracks().forEach(track => track.stop());
            };
            
            mediaRecorder.start();
            isRecording = true;
            els.btnRecord.classList.add('recording');
            els.recordText.textContent = "Stop Recording";
            
        } catch (err) {
            alert("Microphone access denied or error: " + err.message);
        }
    } else {
        // Stop recording
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        isRecording = false;
        els.btnRecord.classList.remove('recording');
        els.recordText.textContent = "Record Live Audio";
    }
}

// Start
init();
