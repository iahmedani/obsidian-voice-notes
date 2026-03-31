import {ItemView} from "obsidian";

export const MEETING_SIDEBAR_TYPE = "vn-meeting-sidebar";

export interface MeetingMoment {
  timestamp: string;
  elapsed: string;
}

export class MeetingSidebar extends ItemView {
  private headerEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private controlsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private appName: string | null = null;
  private captureMethod = "";
  private timerInterval: number | null = null;
  private startTime = 0;
  private paused = false;
  private moments: MeetingMoment[] = [];

  private onStop: (() => void) | null = null;
  private onPause: (() => void) | null = null;
  private onResume: (() => void) | null = null;
  private onMarkMoment: (() => void) | null = null;

  getViewType() { return MEETING_SIDEBAR_TYPE; }
  getDisplayText() { return "Meeting transcription"; }
  getIcon() { return "phone"; }

  setCallbacks(cbs: {onStop: () => void; onPause: () => void; onResume: () => void; onMarkMoment: () => void}) {
    this.onStop = cbs.onStop;
    this.onPause = cbs.onPause;
    this.onResume = cbs.onResume;
    this.onMarkMoment = cbs.onMarkMoment;
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("vn-sidebar");

    this.headerEl = container.createEl("div", {cls: "vn-sb-header"});
    this.headerEl.createEl("span", {cls: "vn-sb-dot"});
    this.headerEl.createEl("span", {cls: "vn-sb-app", text: this.appName || "Meeting"});
    this.timerEl = this.headerEl.createEl("span", {cls: "vn-sb-timer", text: "00:00"});

    this.statusEl = container.createEl("div", {cls: "vn-sb-status", text: "Listening..."});

    this.transcriptEl = container.createEl("div", {cls: "vn-sb-transcript"});
    this.transcriptEl.setText("Waiting for speech...");

    this.controlsEl = container.createEl("div", {cls: "vn-sb-controls"});

    const pauseBtn = this.controlsEl.createEl("button", {cls: "vn-btn vn-stop", text: "Pause"});
    pauseBtn.addEventListener("click", () => {
      if (this.paused) {
        this.paused = false;
        pauseBtn.textContent = "Pause";
        if (this.onResume) this.onResume();
      } else {
        this.paused = true;
        pauseBtn.textContent = "Resume";
        if (this.onPause) this.onPause();
      }
    });

    const momentBtn = this.controlsEl.createEl("button", {cls: "vn-btn vn-ai", text: "Mark moment"});
    momentBtn.addEventListener("click", () => {
      if (this.onMarkMoment) this.onMarkMoment();
    });

    const stopBtn = this.controlsEl.createEl("button", {cls: "vn-btn vn-rec", text: "Stop meeting"});
    stopBtn.addEventListener("click", () => {
      if (this.onStop) this.onStop();
    });
  }

  startRecording(appName: string | null, captureMethod: string) {
    this.appName = appName;
    this.captureMethod = captureMethod;
    this.startTime = Date.now();
    this.paused = false;
    this.moments = [];

    const appEl = this.headerEl?.querySelector(".vn-sb-app");
    if (appEl) appEl.textContent = appName || "Meeting";

    const methodLabels: Record<string, string> = {
      screencapturekit: "System audio",
      blackhole: "BlackHole",
      "mic-only": "Mic only",
    };
    this.statusEl?.setText(`Recording — ${methodLabels[captureMethod] || captureMethod}`);
    this.transcriptEl?.setText("Waiting for speech...");

    this.timerInterval = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      if (this.timerEl) this.timerEl.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  updateTranscript(text: string) {
    if (!this.transcriptEl) return;
    this.transcriptEl.setText(text);
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  addMomentMarker(): MeetingMoment {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    const moment: MeetingMoment = {
      timestamp: new Date().toISOString(),
      elapsed: `${mm}:${ss}`,
    };
    this.moments.push(moment);

    // Insert visual marker in transcript
    if (this.transcriptEl) {
      const marker = this.transcriptEl.createEl("div", {cls: "vn-sb-moment"});
      marker.setText(`--- ⭐ ${mm}:${ss} ---`);
    }
    return moment;
  }

  getMoments(): MeetingMoment[] { return [...this.moments]; }

  showProcessing(message: string) {
    if (this.statusEl) this.statusEl.setText(message);
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    // Disable controls
    if (this.controlsEl) {
      this.controlsEl.querySelectorAll("button").forEach((b: HTMLButtonElement) => b.disabled = true);
    }
  }

  showComplete(notePath: string) {
    if (this.statusEl) this.statusEl.setText("Done!");
    if (this.controlsEl) {
      this.controlsEl.empty();
      const link = this.controlsEl.createEl("button", {cls: "vn-btn vn-save", text: "Open meeting note"});
      link.addEventListener("click", () => {
        void this.app.workspace.openLinkText(notePath, "", true);
      });
    }
  }

  async onClose() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}
