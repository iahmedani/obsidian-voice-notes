import {Platform} from "obsidian";
import {spawn, execSync} from "child_process";
import * as path from "path";
import * as fs from "fs";

const SR = 16000;

export type CaptureMethod = "screencapturekit" | "blackhole" | "mic-only";

interface AudioCaptureCallbacks {
  onPCMData: (data: Float32Array) => void;
  onMicData?: (data: Float32Array) => void;
  onSystemData?: (data: Float32Array) => void;
  onError: (msg: string) => void;
  onReady: () => void;
}

import type {ChildProcess} from "child_process";

export class SystemAudioCapture {
  private method: CaptureMethod = "mic-only";
  private childProcess: ChildProcess | null = null;
  private stream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private actx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string;
  private running = false;

  pluginDir: string = "";

  constructor(private callbacks: AudioCaptureCallbacks, workletUrl: string, pluginDir?: string) {
    this.workletUrl = workletUrl;
    if (pluginDir) this.pluginDir = pluginDir;
  }

  get activeMethod(): CaptureMethod { return this.method; }
  get isRunning(): boolean { return this.running; }

  async start(preferredMethod: string, blackholeDevice: string): Promise<CaptureMethod> {
    if (preferredMethod === "auto" || preferredMethod === "screencapturekit") {
      if (await this.tryScreenCaptureKit()) return this.method;
    }
    if (preferredMethod === "auto" || preferredMethod === "blackhole") {
      if (await this.tryBlackHole(blackholeDevice)) return this.method;
    }
    await this.startMicOnly();
    return this.method;
  }

  private async tryScreenCaptureKit(): Promise<boolean> {
    if (!Platform.isMacOS) return false;

    try {
      const possiblePaths = [
        path.join(this.pluginDir || "", "vn-audio-capture"),
        path.join(process.env.HOME || "", ".voice-notes-whisper", "vn-audio-capture"),
      ];

      let binaryPath = "";
      for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) { binaryPath = p; break; }
      }

      if (!binaryPath) {
        return false;
      }

      // Set up mic capture NOW (during user gesture) so AudioContext isn't suspended
      const micBuf: Float32Array[] = [];
      let micStream: MediaStream | null = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {channelCount: 1, sampleRate: SR, echoCancellation: true, noiseSuppression: true}
        });
        this.actx = new AudioContext({sampleRate: SR});
        await this.actx.audioWorklet.addModule(this.workletUrl);
        const src = this.actx.createMediaStreamSource(micStream);
        const worklet = new AudioWorkletNode(this.actx, "pcm-processor");
        worklet.port.onmessage = (e: MessageEvent) => {
          micBuf.push(e.data as Float32Array);
        };
        src.connect(worklet);
        const silencer = this.actx.createGain();
        silencer.gain.value = 0;
        worklet.connect(silencer);
        silencer.connect(this.actx.destination);
        this.micStream = micStream;
      } catch (e) {
        console.error("[VN] Could not open mic for mixing:", e);
      }

      return new Promise<boolean>((resolve) => {
        const child = spawn(binaryPath, ["--sample-rate", String(SR)], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let resolved = false;
        const timeout = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          console.error("[VN] ScreenCaptureKit: timeout waiting for READY");
          child.kill();
          if (micStream) micStream.getTracks().forEach(t => t.stop());
          resolve(false);
        }, 5000);

        let stderrBuf = "";
        child.stderr.on("data", (data: Buffer) => {
          stderrBuf += data.toString();
          const lines = stderrBuf.split("\n");
          stderrBuf = lines.pop() || "";

          for (const line of lines) {
            const msg = line.trim();

            if (msg === "READY" && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              this.childProcess = child;
              this.method = "screencapturekit";
              this.running = true;

              let leftover = Buffer.alloc(0);
              child.stdout.on("data", (chunk: Buffer) => {
                const combined = Buffer.concat([leftover, chunk]);
                const alignedLen = Math.floor(combined.length / 4) * 4;
                if (alignedLen > 0) {
                  const ab = new ArrayBuffer(alignedLen);
                  const view = new Uint8Array(ab);
                  view.set(combined.subarray(0, alignedLen));
                  const sysAudio = new Float32Array(ab);

                  // Emit raw system audio for diarization
                  if (this.callbacks.onSystemData) this.callbacks.onSystemData(sysAudio);

                  // Drain mic buffer and emit raw mic audio
                  let micData: Float32Array | null = null;
                  if (micBuf.length > 0) {
                    const micChunks = micBuf.splice(0);
                    const micTotal = micChunks.reduce((s, b) => s + b.length, 0);
                    micData = new Float32Array(micTotal);
                    let off = 0;
                    for (const b of micChunks) { micData.set(b, off); off += b.length; }
                    if (this.callbacks.onMicData) this.callbacks.onMicData(micData);
                  }

                  // Mix for transcription
                  if (micData) {
                    const mixLen = Math.max(sysAudio.length, micData.length);
                    const mixed = new Float32Array(mixLen);
                    for (let i = 0; i < mixLen; i++) {
                      const s = i < sysAudio.length ? sysAudio[i] : 0;
                      const m = i < micData.length ? micData[i] : 0;
                      mixed[i] = (s + m) * 0.5;
                    }
                    this.callbacks.onPCMData(mixed);
                  } else {
                    this.callbacks.onPCMData(sysAudio);
                  }
                }
                leftover = Buffer.from(combined.subarray(alignedLen));
              });

              this.callbacks.onReady();
              resolve(true);
            } else if ((msg.startsWith("FATAL:") || msg.startsWith("ERROR:")) && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              console.error("[VN] ScreenCaptureKit failed:", msg);
              child.kill();
              if (micStream) micStream.getTracks().forEach(t => t.stop());
              resolve(false);
            }
          }
        });

        child.on("error", (err) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          console.error("[VN] SCK spawn error:", err.message);
          if (micStream) micStream.getTracks().forEach(t => t.stop());
          resolve(false);
        });

        child.on("exit", () => {
          this.running = false;
        });
      });
    } catch (e) {
      console.error("[VN] SCK error:", e);
      return false;
    }
  }

  private async tryBlackHole(deviceName: string): Promise<boolean> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const bhDevice = devices.find(
        d => d.kind === "audioinput" && d.label.toLowerCase().includes(deviceName.toLowerCase())
      );
      if (!bhDevice) return false;

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {deviceId: {exact: bhDevice.deviceId}, channelCount: 1, sampleRate: SR, echoCancellation: false, noiseSuppression: false}
      });

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {channelCount: 1, sampleRate: SR, echoCancellation: true, noiseSuppression: true}
      });
      this.micStream = micStream;

      this.actx = new AudioContext({sampleRate: SR});
      await this.actx.audioWorklet.addModule(this.workletUrl);

      const bhSource = this.actx.createMediaStreamSource(this.stream);
      const micSource = this.actx.createMediaStreamSource(micStream);

      const bhGain = this.actx.createGain();
      bhGain.gain.value = 0.5;
      const micGain = this.actx.createGain();
      micGain.gain.value = 0.5;

      bhSource.connect(bhGain);
      micSource.connect(micGain);

      this.workletNode = new AudioWorkletNode(this.actx, "pcm-processor");
      bhGain.connect(this.workletNode);
      micGain.connect(this.workletNode);

      this.workletNode.port.onmessage = (e: MessageEvent) => {
        this.callbacks.onPCMData(e.data as Float32Array);
      };

      this.method = "blackhole";
      this.running = true;
      this.callbacks.onReady();
      return true;
    } catch {
      return false;
    }
  }

  private async startMicOnly(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {channelCount: 1, sampleRate: SR, echoCancellation: true, noiseSuppression: true}
    });
    this.actx = new AudioContext({sampleRate: SR});
    await this.actx.audioWorklet.addModule(this.workletUrl);
    const src = this.actx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.actx, "pcm-processor");
    this.workletNode.port.onmessage = (e: MessageEvent) => {
      this.callbacks.onPCMData(e.data as Float32Array);
    };
    src.connect(this.workletNode);
    this.method = "mic-only";
    this.running = true;
    this.callbacks.onReady();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.childProcess) {
      this.childProcess.kill("SIGINT");
      this.childProcess = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.actx) {
      await this.actx.close();
      this.actx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
  }

  static async detectAvailableMethods(blackholeDevice: string): Promise<{sck: boolean; blackhole: boolean}> {
    let sck = false;
    let blackhole = false;

    if (Platform.isMacOS) {
      try {
        const ver = execSync("sw_vers -productVersion", {timeout: 2000}).toString().trim();
        const major = parseInt(ver.split(".")[0]);
        sck = major >= 14;
      } catch { /* ignore */ }
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      blackhole = devices.some(
        d => d.kind === "audioinput" && d.label.toLowerCase().includes(blackholeDevice.toLowerCase())
      );
    } catch { /* ignore */ }

    return {sck, blackhole};
  }
}
