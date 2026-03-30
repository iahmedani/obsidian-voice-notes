import {Platform} from "obsidian";

export interface DetectionResult {
  appName: string | null;
  processName: string | null;
  confidence: "high" | "low" | "none";
}

// Processes that ONLY exist during an active call (not when app is idle)
const ACTIVE_CALL_INDICATORS: {process: string; name: string}[] = [
  // Zoom spawns CptHost only during calls
  {process: "CptHost", name: "Zoom"},
  // Teams spawns MSTeamsCall only during calls
  {process: "MSTeamsCall", name: "Microsoft Teams"},
  // FaceTime notification service = active call
  {process: "FaceTimeNotificationCenterService", name: "FaceTime"},
  // Webex meeting process
  {process: "webexmeetings", name: "Webex"},
];

// Apps that indicate a call when running (these are always-on apps,
// so less reliable — user might just have them open)
const APP_PROCESSES: {process: string; name: string}[] = [
  {process: "zoom.us", name: "Zoom"},
  {process: "WhatsApp", name: "WhatsApp"},
  {process: "FaceTime", name: "FaceTime"},
  {process: "Slack", name: "Slack"},
  {process: "Discord", name: "Discord"},
  {process: "Microsoft Teams", name: "Microsoft Teams"},
  {process: "Teams", name: "Microsoft Teams"},
  {process: "Webex", name: "Webex"},
  {process: "Skype", name: "Skype"},
];

/**
 * Detect which meeting app is likely in an active call.
 * 1. Check for call-specific helper processes (high confidence)
 * 2. Check which meeting app was most recently active (visible window)
 * 3. Fall back to any running meeting app process
 */
export async function detectMeetingApp(customApps: string): Promise<DetectionResult> {
  if (!Platform.isMacOS && !Platform.isDesktop) {
    return {appName: null, processName: null, confidence: "none"};
  }

  const customList: {process: string; name: string}[] = [];
  if (customApps.trim()) {
    for (const name of customApps.split(",").map(s => s.trim()).filter(Boolean)) {
      customList.push({process: name, name});
    }
  }

  try {
    const {exec} = require("child_process") as typeof import("child_process");
    const processes = (await new Promise<string>((resolve, reject) => {
      exec("ps -eo comm= | sort -u", {timeout: 3000}, (err: Error | null, stdout: string) => {
        if (err) reject(err); else resolve(stdout);
      });
    })).toLowerCase();

    // Custom apps always get priority
    for (const app of customList) {
      if (processes.includes(app.process.toLowerCase())) {
        return {appName: app.name, processName: app.process, confidence: "high"};
      }
    }

    // Call-specific processes = definitely in a call
    for (const app of ACTIVE_CALL_INDICATORS) {
      if (processes.includes(app.process.toLowerCase())) {
        return {appName: app.name, processName: app.process, confidence: "high"};
      }
    }

    // Check which meeting app has a visible window (most likely the active call)
    try {
      const visibleApps = (await new Promise<string>((resolve, reject) => {
        exec(
          `osascript -e 'tell application "System Events" to get name of every process whose visible is true'`,
          {timeout: 2000},
          (err: Error | null, stdout: string) => { if (err) reject(err); else resolve(stdout); }
        );
      })).toLowerCase();

      for (const app of APP_PROCESSES) {
        if (visibleApps.includes(app.name.toLowerCase()) && processes.includes(app.process.toLowerCase())) {
          return {appName: app.name, processName: app.process, confidence: "high"};
        }
      }
    } catch { /* fall through to basic process check */ }

    // Fallback: any running meeting app
    for (const app of APP_PROCESSES) {
      if (processes.includes(app.process.toLowerCase())) {
        return {appName: app.name, processName: app.process, confidence: "low"};
      }
    }

    return {appName: null, processName: null, confidence: "none"};
  } catch {
    return {appName: null, processName: null, confidence: "none"};
  }
}

/**
 * Lightweight check for background polling (every 30s).
 */
export async function quickDetectCallApp(customApps: string): Promise<string | null> {
  if (!Platform.isMacOS && !Platform.isDesktop) return null;

  try {
    const {exec} = require("child_process") as typeof import("child_process");
    const processes = (await new Promise<string>((resolve, reject) => {
      exec("ps -eo comm= | sort -u", {timeout: 2000}, (err: Error | null, stdout: string) => {
        if (err) reject(err); else resolve(stdout);
      });
    })).toLowerCase();

    const allApps = [...ACTIVE_CALL_INDICATORS];
    if (customApps.trim()) {
      for (const name of customApps.split(",").map(s => s.trim()).filter(Boolean)) {
        allApps.push({process: name, name});
      }
    }

    for (const app of allApps) {
      if (processes.includes(app.process.toLowerCase())) {
        return app.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}
