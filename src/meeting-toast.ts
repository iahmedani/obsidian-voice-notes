export interface ToastResult {
  accepted: boolean;
}

export function showMeetingToast(
  appName: string | null,
  dismissSeconds: number
): Promise<ToastResult> {
  return new Promise((resolve) => {
    const container = document.createElement("div");
    container.className = "vn-meeting-toast";

    const msg = appName
      ? `${appName} call detected — Transcribe?`
      : "Start meeting transcription?";

    container.createSpan({cls: "vn-toast-icon", text: "\uD83C\uDF99\uFE0F"});
    container.createSpan({cls: "vn-toast-msg", text: msg});
    container.createEl("button", {cls: "vn-toast-btn vn-toast-yes", text: "Yes"});
    container.createEl("button", {cls: "vn-toast-btn vn-toast-no", text: "No"});
    container.createSpan({cls: "vn-toast-timer", text: `${dismissSeconds}s`});

    let remaining = dismissSeconds;
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(countdown);
      container.remove();
    };

    const yesBtn = container.querySelector(".vn-toast-yes") as HTMLButtonElement;
    const noBtn = container.querySelector(".vn-toast-no") as HTMLButtonElement;
    const timerEl = container.querySelector(".vn-toast-timer") as HTMLElement;

    yesBtn.addEventListener("click", () => {
      cleanup();
      resolve({accepted: true});
    });

    noBtn.addEventListener("click", () => {
      cleanup();
      resolve({accepted: false});
    });

    const countdown = window.setInterval(() => {
      remaining--;
      timerEl.textContent = `${remaining}s`;
      if (remaining <= 0) {
        cleanup();
        resolve({accepted: false});
      }
    }, 1000);

    document.body.appendChild(container);
  });
}
