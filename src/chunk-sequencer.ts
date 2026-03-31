import {requestUrl} from "obsidian";
import {mergePCM, f32ToB64} from "./audio-utils";

const SR = 16000;

/**
 * Manages ordered chunk transcription: dispatches audio chunks to the server,
 * collects results, and flushes them in sequence order.
 */
export class ChunkSequencer {
  private seq = 0;
  private nextFlush = 0;
  private results: Map<number, string> = new Map();
  private onText: (text: string) => void;
  private serverUrl: string;
  private language: string;
  private timeoutMs: number;
  detectedLanguage = "en";

  constructor(opts: {
    serverUrl: string;
    language: string;
    timeoutMs: number;
    onText: (text: string) => void;
  }) {
    this.serverUrl = opts.serverUrl;
    this.language = opts.language;
    this.timeoutMs = opts.timeoutMs;
    this.onText = opts.onText;
  }

  /** Send a chunk of PCM buffers to the server for transcription. */
  send(bufs: Float32Array[]): void {
    const m = mergePCM(bufs);
    const seq = this.seq++;
    const timeout = window.setTimeout(() => {
      if (!this.results.has(seq)) {
        this.results.set(seq, "");
        this.flush();
      }
    }, this.timeoutMs);

    void requestUrl({
      url: this.serverUrl + "/transcribe",
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        audio_pcm_base64: f32ToB64(m),
        format: "float32",
        sample_rate: SR,
        language: this.language,
        is_chunk: true,
      }),
    }).then(r => {
      clearTimeout(timeout);
      const t = (r.status === 200 && r.json.text) ? r.json.text.trim() : "";
      if (r.json.detected_language) this.detectedLanguage = r.json.detected_language as string;
      this.results.set(seq, t);
      this.flush();
      return t;
    }).catch(() => {
      clearTimeout(timeout);
      this.results.set(seq, "");
      this.flush();
    });
  }

  /** Flush results in order, calling onText for each non-empty result. */
  private flush(): void {
    while (this.results.has(this.nextFlush)) {
      const t = this.results.get(this.nextFlush) || "";
      this.results.delete(this.nextFlush);
      if (t) this.onText(t);
      this.nextFlush++;
    }
  }

  /** True if there are still in-flight or unflushed results. */
  get hasPending(): boolean {
    return this.results.size > 0 || this.nextFlush < this.seq;
  }

  /** Reset state for a new session. */
  reset(): void {
    this.seq = 0;
    this.nextFlush = 0;
    this.results.clear();
  }
}
