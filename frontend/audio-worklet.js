/**
 * 🎤 AudioWorklet Processor for VaaniAI
 * Captures microphone input, resamples to 16kHz, and sends as PCM Int16.
 *
 * Runs in a separate audio thread for minimal latency.
 */

class VaaniAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        // Target sample rate (STT server expects 16kHz)
        this.targetSampleRate = 16000;
        // Browser's native sample rate (usually 48000 or 44100)
        this.inputSampleRate = options.processorOptions?.sampleRate || 48000;
        // Ratio for resampling
        this.resampleRatio = this.targetSampleRate / this.inputSampleRate;

        // Buffer for accumulating samples before sending
        // Send every ~30ms of audio at 16kHz = 480 samples
        this.bufferSize = 480;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferOffset = 0;

        // Resampling state (linear interpolation)
        this.resampleIndex = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === 'config') {
                this.inputSampleRate = event.data.sampleRate || this.inputSampleRate;
                this.resampleRatio = this.targetSampleRate / this.inputSampleRate;
            }
        };
    }

    /**
     * Process audio frames from the microphone.
     * Called by the audio thread approximately every 128 samples.
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) {
            return true;
        }

        // Take first channel (mono)
        const channelData = input[0];

        // Resample from input rate to 16kHz using linear interpolation
        const resampledLength = Math.floor(channelData.length * this.resampleRatio);

        for (let i = 0; i < resampledLength; i++) {
            const srcIndex = i / this.resampleRatio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, channelData.length - 1);
            const frac = srcIndex - srcIndexFloor;

            // Linear interpolation
            const sample = channelData[srcIndexFloor] * (1 - frac) + channelData[srcIndexCeil] * frac;

            this.buffer[this.bufferOffset++] = sample;

            // When buffer is full, send it
            if (this.bufferOffset >= this.bufferSize) {
                this._sendBuffer();
            }
        }

        return true; // Keep processor alive
    }

    /**
     * Convert float32 buffer to int16 PCM and send to main thread.
     */
    _sendBuffer() {
        // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const int16Buffer = new Int16Array(this.bufferOffset);
        for (let i = 0; i < this.bufferOffset; i++) {
            const s = Math.max(-1, Math.min(1, this.buffer[i]));
            int16Buffer[i] = s < 0 ? s * 32768 : s * 32767;
        }

        // Send to main thread
        this.port.postMessage({
            type: 'audio',
            buffer: int16Buffer.buffer,
        }, [int16Buffer.buffer]); // Transfer ownership for zero-copy

        // Reset buffer
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferOffset = 0;
    }
}

registerProcessor('vaani-audio-processor', VaaniAudioProcessor);
