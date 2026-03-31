import {App, moment, requestUrl} from "obsidian";
import {MeetingMoment} from "./meeting-sidebar";
import {mergePCM, f32ToB64, pcmToWav, ensureFolder} from "./audio-utils";

const SR = 16000;

interface PostMeetingInput {
  pcmBuffers: Float32Array[];
  micPcmBuffers: Float32Array[];
  sysPcmBuffers: Float32Array[];
  transcript: string;
  moments: MeetingMoment[];
  appName: string | null;
  captureMethod: string;
  startTime: number;
  settings: {
    serverUrl: string;
    notesFolder: string;
    audioFolder: string;
    aiEnabled: boolean;
    aiProvider: string;
    aiApiKey: string;
    aiModel: string;
    aiBaseUrl: string;
    aiCustomPrompt: string;
    diarizeEnabled: boolean;
    diarizeNumSpeakers: number;
    language: string;
    whisperModel: string;
  };
  postAction: string;
  diarize: boolean;
}

interface ActionItem {
  task: string;
  owner: string;
  due: string;
  priority: string;
}

interface ExtractedActions {
  action_items: ActionItem[];
  decisions: string[];
  follow_ups: string[];
}


/**
 * Instant stereo-based diarization.
 * Splits transcript into sentences, then for each sentence's time window
 * compares mic energy (you) vs system energy (them) to assign speaker.
 * Runs in <10ms, no server round-trip.
 */
function stereoLabel(transcript: string, micPcm: Float32Array, sysPcm: Float32Array, totalSamples: number): string {
  // Split transcript into sentences
  const sentences = transcript.match(/[^.!?]+[.!?]*\s*/g) || [transcript];
  if (sentences.length === 0) return transcript;

  const samplesPerSentence = Math.floor(totalSamples / sentences.length);
  let currentSpeaker = "";
  const labeled: string[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const start = i * samplesPerSentence;
    const end = Math.min(start + samplesPerSentence, totalSamples);

    // Compute RMS energy for this time window in each stream
    const micSlice = micPcm.subarray(
      Math.min(start, micPcm.length),
      Math.min(end, micPcm.length)
    );
    const sysSlice = sysPcm.subarray(
      Math.min(start, sysPcm.length),
      Math.min(end, sysPcm.length)
    );

    const micRms = rms(micSlice);
    const sysRms = rms(sysSlice);

    // Determine speaker: whoever has higher energy in this window
    // Use 1.5x threshold to avoid flip-flopping on similar levels
    let speaker: string;
    if (micRms > sysRms * 1.5) {
      speaker = "Me";
    } else if (sysRms > micRms * 1.5) {
      speaker = "Speaker";
    } else if (micRms > sysRms) {
      speaker = "Me";
    } else {
      speaker = "Speaker";
    }

    const text = sentences[i].trim();
    if (!text) continue;

    if (speaker !== currentSpeaker) {
      currentSpeaker = speaker;
      labeled.push(`\n\n**${speaker}:** ${text}`);
    } else {
      labeled.push(text);
    }
  }

  return labeled.join(" ").trim();
}

function rms(arr: Float32Array): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

export async function processPostMeeting(
  app: App,
  input: PostMeetingInput,
  onStatus: (msg: string) => void
): Promise<string> {
  const now = moment();
  const ds = now.format("YYYY-MM-DD");
  const ts = now.format("HH-mm-ss");
  const dd = now.format("dddd, Do MMMM YYYY HH:mm");
  const elapsed = Math.floor((Date.now() - input.startTime) / 1000);
  const dur = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  // Save audio
  onStatus("Saving audio...");
  const af = input.settings.audioFolder;
  const appSlug = input.appName ? `-${input.appName.toLowerCase().replace(/\s+/g, "-")}` : "";
  const afn = `meeting${appSlug}-${ds}-${ts}.wav`;
  const ap = `${af}/${afn}`;
  await ensureFolder(app, af);
  const merged = mergePCM(input.pcmBuffers);
  const wavBuf = pcmToWav(merged, SR);
  await app.vault.adapter.writeBinary(ap, wavBuf);

  // Diarization: stereo-based (instant) if we have separate streams, else server-based
  let finalTranscript = input.transcript;
  const hasStereo = input.micPcmBuffers.length > 0 && input.sysPcmBuffers.length > 0;

  if (input.diarize && input.settings.diarizeEnabled) {
    if (hasStereo) {
      // Instant stereo diarization — compare mic vs system energy per sentence
      onStatus("Labeling speakers...");
      const micMerged = mergePCM(input.micPcmBuffers);
      const sysMerged = mergePCM(input.sysPcmBuffers);
      finalTranscript = stereoLabel(input.transcript, micMerged, sysMerged, merged.length);
    } else {
      // Fallback: server-based pyannote diarization (slower)
      onStatus("Running diarization...");
      try {
        const r = await requestUrl({
          url: input.settings.serverUrl + "/transcribe", method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            audio_pcm_base64: f32ToB64(merged), format: "float32", sample_rate: SR,
            language: input.settings.language,
            is_chunk: false, diarize: true,
            num_speakers: input.settings.diarizeNumSpeakers || null,
          }),
        });
        if (r.status === 200 && r.json.text) finalTranscript = r.json.text;
      } catch (e) { console.error("[VN] Diarization failed:", e); onStatus("Diarization failed, using chunk transcript"); }
    }
  }

  const wc = finalTranscript.split(/\s+/).filter((w: string) => w).length;

  // AI Summary (level 2+) and Action items (level 3) — run in parallel for "full"
  let summary = "";
  let actions: ExtractedActions | null = null;
  if (input.settings.aiEnabled) {
    if (input.postAction === "summary") {
      onStatus("Generating AI summary...");
      try {
        const r = await requestUrl({
          url: input.settings.serverUrl + "/summarize", method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            transcript: finalTranscript, provider: input.settings.aiProvider,
            api_key: input.settings.aiApiKey, model: input.settings.aiModel,
            base_url: input.settings.aiBaseUrl, custom_prompt: input.settings.aiCustomPrompt,
          }),
        });
        if (r.status === 200 && r.json.summary) summary = r.json.summary;
      } catch (e) { console.error("[VN] Summarization failed:", e); onStatus("Summarization failed"); }
    } else if (input.postAction === "full") {
      onStatus("Generating AI summary and extracting action items...");
      const [summaryResult, actionsResult] = await Promise.allSettled([
        requestUrl({
          url: input.settings.serverUrl + "/summarize", method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            transcript: finalTranscript, provider: input.settings.aiProvider,
            api_key: input.settings.aiApiKey, model: input.settings.aiModel,
            base_url: input.settings.aiBaseUrl, custom_prompt: input.settings.aiCustomPrompt,
          }),
        }),
        requestUrl({
          url: input.settings.serverUrl + "/extract-actions", method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            transcript: finalTranscript, provider: input.settings.aiProvider,
            api_key: input.settings.aiApiKey, model: input.settings.aiModel,
            base_url: input.settings.aiBaseUrl,
          }),
        }),
      ]);
      if (summaryResult.status === "fulfilled") {
        const r = summaryResult.value;
        if (r.status === 200 && r.json.summary) summary = r.json.summary;
      } else { console.error("[VN] Summarization failed:", summaryResult.reason); onStatus("Summarization failed"); }
      if (actionsResult.status === "fulfilled") {
        const r = actionsResult.value;
        if (r.status === 200) actions = r.json;
      } else { console.error("[VN] Action extraction failed:", actionsResult.reason); onStatus("Action extraction failed"); }
    }
  }

  // Build the note
  onStatus("Creating meeting note...");
  const appLabel = input.appName ? ` (${input.appName})` : "";
  let nc = `---\ncreated: ${now.format("YYYY-MM-DDTHH:mm")}\ntype: meeting-notes\ndate: ${ds}\nduration: "${dur}"\nwords: ${wc}\naudio: "[[${afn}]]"\napp: "${input.appName || "Unknown"}"\ncapture: "${input.captureMethod}"\ntags:\n  - meeting-notes\n  - auto-transcribed\n---\n\n# Meeting Notes — ${dd}${appLabel}\n\n> [!info] Details\n> Duration: ${dur} | Words: ${wc} | Capture: ${input.captureMethod}\n> Audio: ![[${afn}]]\n`;

  // Moments / bookmarks
  if (input.moments.length > 0) {
    nc += `\n## Bookmarked Moments\n\n`;
    for (const m of input.moments) {
      nc += `- ⭐ **${m.elapsed}**\n`;
    }
  }

  // Summary
  if (summary) {
    nc += `\n---\n\n${summary}\n`;
  }

  // Action items
  if (actions) {
    if (actions.action_items && actions.action_items.length > 0) {
      nc += `\n## Action Items\n\n`;
      for (const item of actions.action_items) {
        const owner = item.owner ? ` — @${item.owner}` : "";
        const priority = item.priority ? ` (${item.priority})` : "";
        const due = item.due ? ` 📅 ${item.due}` : "";
        nc += `- [ ] ${item.task}${owner}${priority}${due}\n`;
      }
    }
    if (actions.decisions && actions.decisions.length > 0) {
      nc += `\n## Key Decisions\n\n`;
      for (const d of actions.decisions) {
        nc += `- ${d}\n`;
      }
    }
    if (actions.follow_ups && actions.follow_ups.length > 0) {
      nc += `\n## Follow-ups\n\n`;
      for (const f of actions.follow_ups) {
        nc += `- ${f}\n`;
      }
    }
  }

  // Transcript
  nc += `\n---\n\n> [!note]- Full Transcript\n>\n> ${finalTranscript.trim().split("\n").join("\n> ")}\n\n---\n\n*[[${ds}]]*\n`;

  // Generate short AI title for the file name
  let meetingTitle = "";
  if (input.settings.aiEnabled && finalTranscript.trim().length > 50) {
    onStatus("Generating meeting title...");
    try {
      const titlePrompt = `Give a short title (3-6 words, no quotes, no punctuation) for this meeting based on the transcript. Return ONLY the title, nothing else:\n\n${finalTranscript.slice(0, 2000)}`;
      const r = await requestUrl({
        url: input.settings.serverUrl + "/summarize", method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          transcript: titlePrompt, provider: input.settings.aiProvider,
          api_key: input.settings.aiApiKey, model: input.settings.aiModel,
          base_url: input.settings.aiBaseUrl, custom_prompt: titlePrompt,
        }),
      });
      if (r.status === 200 && r.json.summary) {
        meetingTitle = r.json.summary.trim()
          .replace(/['"]/g, "")
          .replace(/[^a-zA-Z0-9\s-]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
      }
    } catch (e) { console.error("[VN] Title generation failed:", e); }
  }

  // Save note
  const nf = input.settings.notesFolder;
  await ensureFolder(app, nf);
  const slug = meetingTitle ? ` ${meetingTitle}` : `${appSlug}`;
  const np = `${nf}/MTG - ${ds} ${ts}${slug}.md`;
  await app.vault.create(np, nc);
  return np;
}
