import {App, Modal, Setting} from "obsidian";

export interface MeetingConfig {
  appName: string | null;
  captureMethod: string;
  diarize: boolean;
  postAction: string;
}

export class MeetingConfirmModal extends Modal {
  private config: MeetingConfig;
  private onStart: ((config: MeetingConfig) => void) | null = null;
  private onCancel: (() => void) | null = null;

  constructor(app: App, config: MeetingConfig) {
    super(app);
    this.config = {...config};
  }

  open(): Promise<MeetingConfig | null> {
    return new Promise((resolve) => {
      this.onStart = (cfg) => resolve(cfg);
      this.onCancel = () => resolve(null);
      super.open();
    });
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass("vn-modal");
    c.createEl("h2", {text: "Start Meeting Transcription", cls: "vn-title"});

    const infoDiv = c.createEl("div", {cls: "vn-meeting-info"});
    if (this.config.appName) {
      infoDiv.createEl("div", {text: `Detected: ${this.config.appName}`, cls: "vn-meeting-app"});
    }

    const methodLabels: Record<string, string> = {
      auto: "System Audio (Auto-detect)",
      screencapturekit: "System Audio (ScreenCaptureKit)",
      blackhole: "System Audio (BlackHole)",
      "mic-only": "Microphone Only",
    };
    infoDiv.createEl("div", {
      text: `Audio: ${methodLabels[this.config.captureMethod] || this.config.captureMethod}`,
      cls: "vn-meeting-audio",
    });

    if (this.config.captureMethod === "mic-only") {
      infoDiv.createEl("div", {
        text: "Note: Only your microphone will be captured. Other participants won't be transcribed.",
        cls: "vn-meeting-warn",
      });
    }

    new Setting(c)
      .setName("Speaker diarization")
      .setDesc("Identify who said what")
      .addToggle(t => t.setValue(this.config.diarize).onChange(v => { this.config.diarize = v; }));

    new Setting(c)
      .setName("After meeting")
      .addDropdown(d => d
        .addOption("transcript", "Save transcript only")
        .addOption("summary", "Generate AI summary")
        .addOption("full", "Full notes + action items")
        .setValue(this.config.postAction)
        .onChange(v => { this.config.postAction = v; })
      );

    const btnRow = c.createEl("div", {cls: "vn-ctrl"});
    const startBtn = btnRow.createEl("button", {cls: "vn-btn vn-rec", text: "Start Transcribing"});
    startBtn.addEventListener("click", () => {
      // Grab callback before close() triggers onClose() which nulls it
      const cb = this.onStart;
      this.onStart = null;
      this.onCancel = null;
      this.close();
      if (cb) cb(this.config);
    });

    const cancelBtn = btnRow.createEl("button", {cls: "vn-btn vn-stop", text: "Cancel"});
    cancelBtn.addEventListener("click", () => {
      const cb = this.onCancel;
      this.onStart = null;
      this.onCancel = null;
      this.close();
      if (cb) cb();
    });
  }

  onClose() {
    // Only fire cancel if not already handled by button clicks
    if (this.onCancel) {
      const cb = this.onCancel;
      this.onCancel = null;
      this.onStart = null;
      cb();
    }
  }
}
