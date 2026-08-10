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
    languageSelect: document.getElementById('languageSelect'),
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
                <div class="voice-info">
                    <span class="voice-name">${voice.name}</span>
                    <span class="voice-size">${sizeKb} KB</span>
                </div>
            `;
            li.onclick = () => {
                document.querySelectorAll('.voice-item').forEach(el => el.classList.remove('active'));
                li.classList.add('active');
                els.voiceSelect.value = voice.filename;
            };
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
    const text = els.textInput.value.trim();
    const voice = els.voiceSelect.value;
    const language = els.languageSelect.value;
    
    if (!text) {
        alert("Please enter some text to synthesize.");
        return;
    }
    if (!voice) {
        alert("Please select a voice from the library.");
        return;
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
                speed: 1.0,
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
