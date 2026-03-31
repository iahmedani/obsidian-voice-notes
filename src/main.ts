import {App,FileSystemAdapter,MarkdownView,Modal,Notice,Plugin,PluginSettingTab,Setting,TFile,requestUrl} from "obsidian";
import {detectMeetingApp, quickDetectCallApp} from "./meeting-detector";
import {SystemAudioCapture, CaptureMethod} from "./system-audio";
import {showMeetingToast} from "./meeting-toast";
import {MeetingConfirmModal, MeetingConfig} from "./meeting-modal";
import {MeetingSidebar, MEETING_SIDEBAR_TYPE} from "./meeting-sidebar";
import {processPostMeeting} from "./post-meeting";
import {mergePCM, f32ToB64, pcmToWav, ensureFolder} from "./audio-utils";
import {ChunkSequencer} from "./chunk-sequencer";
interface VNSettings {serverUrl:string;whisperModel:string;language:string;chunkSeconds:number;notesFolder:string;audioFolder:string;aiEnabled:boolean;aiProvider:string;aiApiKey:string;aiModel:string;aiBaseUrl:string;aiCustomPrompt:string;diarizeEnabled:boolean;diarizeNumSpeakers:number;translateToEnglish:boolean;meetingEnabled:boolean;audioCaptureMethod:string;blackholeDeviceName:string;meetingPostAction:string;toastDismissSeconds:number;autoOpenSidebar:boolean;markMomentEnabled:boolean;meetingApps:string}
const DEFAULTS:VNSettings={serverUrl:"http://127.0.0.1:5678",whisperModel:"mlx-community/whisper-large-v3-turbo",language:"en",chunkSeconds:3,notesFolder:"Voice Notes",audioFolder:"Attachments/Audio",aiEnabled:false,aiProvider:"anthropic",aiApiKey:"",aiModel:"",aiBaseUrl:"",aiCustomPrompt:"",diarizeEnabled:false,diarizeNumSpeakers:0,translateToEnglish:false,meetingEnabled:false,audioCaptureMethod:"auto",blackholeDeviceName:"BlackHole 2ch",meetingPostAction:"summary",toastDismissSeconds:15,autoOpenSidebar:true,markMomentEnabled:true,meetingApps:""};
const SR=16000;
const MAX_PCM_SAMPLES=SR*60*30; // 30 minutes max (~115MB)

function createWorkletUrl():string{
  const code=`class PCMProcessor extends AudioWorkletProcessor{process(inputs){const ch=inputs[0]?.[0];if(ch){const copy=new Float32Array(ch.length);copy.set(ch);this.port.postMessage(copy,[copy.buffer])}return true}}registerProcessor("pcm-processor",PCMProcessor);`;
  const blob=new Blob([code],{type:"application/javascript"});
  return URL.createObjectURL(blob);
}
let workletUrl:string|null=null;
function getWorkletUrl():string{if(!workletUrl)workletUrl=createWorkletUrl();return workletUrl}

export default class VoiceNotesPlugin extends Plugin {
  settings:VNSettings=DEFAULTS;
  private isRec=false;private stream:MediaStream|null=null;private actx:AudioContext|null=null;private workletNode:AudioWorkletNode|null=null;
  private pcm:Float32Array[]=[];private pending:Float32Array[]=[];private ci:number|null=null;private sbar:HTMLElement|null=null;
  private rib:HTMLElement|null=null;private pi:number|null=null;private t0=0;
  private chunker:ChunkSequencer|null=null;private fullTranscript:string[]=[];private originalTranscript:string[]=[];private detectedLang="en";
  private meetingActive=false;private meetingCapture:SystemAudioCapture|null=null;
  private meetingPcm:Float32Array[]=[];private meetingMicPcm:Float32Array[]=[];private meetingSysPcm:Float32Array[]=[];private meetingPending:Float32Array[]=[];private meetingPcmSamples=0;
  private meetingCI:number|null=null;
  private meetingChunker:ChunkSequencer|null=null;
  private meetingTexts:string[]=[];private meetingT0=0;
  private meetingAppName:string|null=null;private meetingMethod:CaptureMethod="mic-only";
  private meetingConfig:MeetingConfig|null=null;private meetingPaused=false;
  private meetingPollInterval:number|null=null;private lastDetectedApp:string|null=null;private toastShowing=false;

  private getMeetingSidebarView():MeetingSidebar|null{
    const leaves=this.app.workspace.getLeavesOfType(MEETING_SIDEBAR_TYPE);
    for(const l of leaves){if(l.view instanceof MeetingSidebar)return l.view}
    return null;
  }

  async onload(){
    await this.loadSettings();
    this.rib=this.addRibbonIcon("mic","Toggle dictation",()=>{void this.toggle()});
    this.sbar=this.addStatusBarItem();this.sbar.setText("");
    this.addCommand({id:"toggle-dictation",name:"Toggle dictation (voice to cursor)",callback:()=>{void this.toggle()}});
    this.addCommand({id:"record-voice-note",name:"Record full voice note (modal)",callback:()=>{new RecModal(this.app,this).open()}});
    this.addCommand({id:"summarize-selection",name:"Generate meeting notes from selection",callback:()=>{void this.sumSel()}});
    this.addCommand({id:"check-server",name:"Check Whisper server status",callback:()=>{void this.chk()}});
    this.addSettingTab(new VNSettingsTab(this.app,this));
    // Meeting mode
    this.registerView(MEETING_SIDEBAR_TYPE, (leaf) => new MeetingSidebar(leaf));
    this.addCommand({id:"start-meeting",name:"Start meeting transcription",callback:()=>{void this.startMeeting()}});
    this.addCommand({id:"stop-meeting",name:"Stop meeting transcription",callback:()=>{void this.stopMeeting()}});
    this.addCommand({id:"mark-moment",name:"Mark moment in meeting",callback:()=>{const sb=this.getMeetingSidebarView();if(sb&&this.meetingActive)sb.addMomentMarker()}});
    if(this.settings.meetingEnabled){
      this.addRibbonIcon("phone","Start meeting transcription",()=>{void this.startMeeting()});
      // Start background polling for active calls (every 30 seconds)
      this.startMeetingPoll();
    }
  }
  onunload(){if(this.isRec)void this.stop();if(this.meetingActive)void this.stopMeeting();this.stopMeetingPoll()}
  async loadSettings(){this.settings=Object.assign({},DEFAULTS,await this.loadData())}
  async saveSettings(){await this.saveData(this.settings)}

  async toggle(){if(this.isRec)await this.stop();else await this.start()}

  async start(){
    const v=this.app.workspace.getActiveViewOfType(MarkdownView);
    if(!v){new Notice("Open a note first.");return}
    if(!(await this.ready())){new Notice("Whisper server not reachable.");return}
    try{
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:SR,echoCancellation:true,noiseSuppression:true}});
      this.actx=new AudioContext({sampleRate:SR});
      await this.actx.audioWorklet.addModule(getWorkletUrl());
      const src=this.actx.createMediaStreamSource(this.stream);
      this.workletNode=new AudioWorkletNode(this.actx,"pcm-processor");
      this.pcm=[];this.pending=[];this.fullTranscript=[];this.originalTranscript=[];this.detectedLang="en";
      this.chunker=new ChunkSequencer({serverUrl:this.settings.serverUrl,language:this.settings.language,timeoutMs:10000,onText:(t)=>{this.originalTranscript.push(t);this.detectedLang=this.chunker?.detectedLanguage||"en";if(this.settings.translateToEnglish&&this.settings.aiEnabled&&this.detectedLang!=="en"){void this.translate(t,this.detectedLang).then(tr=>{this.fullTranscript.push(tr);this.ins(tr)}).catch(()=>{})}else{this.fullTranscript.push(t);this.ins(t)}}});
      this.workletNode.port.onmessage=(e:MessageEvent)=>{const c=e.data as Float32Array;this.pcm.push(c);this.pending.push(c)};
      src.connect(this.workletNode);
      this.isRec=true;this.t0=Date.now();
      this.ci=window.setInterval(()=>this.chunk(),this.settings.chunkSeconds*1000);
      this.ui(true);new Notice("Dictation started");
    }catch(e){new Notice("Mic failed: "+e)}
  }

  async stop(){
    if(!this.isRec)return;
    if(this.ci){clearInterval(this.ci);this.ci=null}
    if(this.pending.length>0)this.chunk();
    const waitStart=Date.now();
    while(this.chunker?.hasPending&&Date.now()-waitStart<5000){await new Promise(r=>setTimeout(r,100))}
    if(this.workletNode){this.workletNode.disconnect();this.workletNode=null}
    if(this.actx){void this.actx.close();this.actx=null}
    if(this.stream){this.stream.getTracks().forEach(t=>t.stop());this.stream=null}
    this.isRec=false;this.ui(false);
    const el=Math.floor((Date.now()-this.t0)/1000);
    const dur=Math.floor(el/60)+"m "+(el%60)+"s";
    // Save audio + insert callout
    if(this.pcm.length>0){
      const now=window.moment();const ds=now.format("YYYY-MM-DD");const ts=now.format("HH-mm-ss");
      const af=this.settings.audioFolder;const afn=`voice-dictation-${ds}-${ts}.wav`;const ap=`${af}/${afn}`;
      await ensureFolder(this.app,af);
      const merged=mergePCM(this.pcm);const wavBuf=pcmToWav(merged,SR);
      await this.app.vault.adapter.writeBinary(ap,wavBuf);
      const transcript=this.fullTranscript.join(" ").trim();
      const original=this.originalTranscript.join(" ").trim();
      const isTranslated=this.settings.translateToEnglish&&this.settings.aiEnabled&&this.detectedLang!=="en"&&original!==transcript;
      const langLabel=isTranslated?` — ${this.detectedLang.toUpperCase()}`:"";
      const calloutText=isTranslated?original:transcript;
      const v=this.app.workspace.getActiveViewOfType(MarkdownView);
      if(v&&(transcript||original)){
        const ed=v.editor;const cur=ed.getCursor();
        const callout=`\n\n> [!note]- Dictation (${dur})${langLabel}\n> ![[${afn}]]\n>\n> ${calloutText.split("\n").join("\n> ")}\n`;
        ed.replaceRange(callout,cur);
        ed.setCursor(ed.lineCount()-1,0);
      }
    }
    new Notice("Dictation stopped ("+dur+")");
  }

  private chunk(){
    if(this.pending.length===0)return;
    const bufs=[...this.pending];this.pending=[];
    this.chunker?.send(bufs);
  }

  private async translate(text:string,sourceLang:string):Promise<string>{
    if(!text.trim()||!this.settings.aiEnabled||!this.settings.translateToEnglish||sourceLang==="en")return text;
    try{
      const r=await requestUrl({url:this.settings.serverUrl+"/translate",method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({text,source_language:sourceLang,provider:this.settings.aiProvider,api_key:this.settings.aiApiKey,model:this.settings.aiModel,base_url:this.settings.aiBaseUrl})});
      if(r.status===200&&r.json.translation)return r.json.translation.trim();
    }catch(e){console.error("Translation failed:",e)}
    return text;
  }

  private ins(text:string){
    const v=this.app.workspace.getActiveViewOfType(MarkdownView);if(!v)return;
    const ed=v.editor;const cur=ed.getCursor();const ln=ed.getLine(cur.line);
    const cb=ln.charAt(cur.ch-1);const sp=cur.ch>0&&cb!==" "&&cb!=="\n";
    const it=(sp?" ":"")+text;
    ed.replaceRange(it,cur);ed.setCursor({line:cur.line,ch:cur.ch+it.length});
  }

  async sumSel(){
    const v=this.app.workspace.getActiveViewOfType(MarkdownView);if(!v){new Notice("Open a note first.");return}
    if(!this.settings.aiEnabled){new Notice("AI summarization disabled. Enable in settings.");return}
    const ed=v.editor;let tx=ed.getSelection()||ed.getValue();
    if(!tx.trim()){new Notice("No text to summarize.");return}
    new Notice("Generating meeting notes...");
    try{
      const r=await requestUrl({url:this.settings.serverUrl+"/summarize",method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({transcript:tx,provider:this.settings.aiProvider,api_key:this.settings.aiApiKey,model:this.settings.aiModel,base_url:this.settings.aiBaseUrl,custom_prompt:this.settings.aiCustomPrompt})});
      if(r.status===200&&r.json.summary){
        const now=window.moment();const ds=now.format("YYYY-MM-DD");const ts=now.format("HH-mm-ss");const dd=now.format("dddd, Do MMMM YYYY HH:mm");
        const nc=`---\ncreated: ${now.format("YYYY-MM-DDTHH:mm")}\ntype: meeting-notes\ndate: ${ds}\nai_provider: ${this.settings.aiProvider}\ntags:\n  - meeting-notes\n  - ai-generated\n---\n\n# Meeting Notes — ${dd}\n\n> [!info] AI Generated\n> Provider: ${this.settings.aiProvider} | Model: ${this.settings.aiModel||"default"}\n\n---\n\n${r.json.summary}\n\n---\n\n> [!note]- Original Transcript\n>\n> ${tx.trim().split("\n").join("\n> ")}\n`;
        await ensureFolder(this.app,this.settings.notesFolder);
        const np=this.settings.notesFolder+"/MTG - "+ds+" "+ts+".md";
        await this.app.vault.create(np,nc);
        const f=this.app.vault.getAbstractFileByPath(np);
        if(f instanceof TFile)await this.app.workspace.getLeaf("tab").openFile(f);
        new Notice("Meeting notes generated!");
      }else{new Notice("Failed: "+(r.json.error||"Unknown"))}
    }catch(e){new Notice("Failed: "+e)}
  }

  private ui(rec:boolean){
    if(this.rib){if(rec)this.rib.addClass("voice-notes-recording");else this.rib.removeClass("voice-notes-recording")}
    if(this.sbar){
      if(rec){this.usb();this.pi=window.setInterval(()=>this.usb(),1000)}
      else{if(this.pi){clearInterval(this.pi);this.pi=null}this.sbar.setText("")}
    }
  }
  private usb(){if(!this.sbar||!this.isRec)return;const e=Math.floor((Date.now()-this.t0)/1000);this.sbar.setText("REC "+String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"))}
  private async ready():Promise<boolean>{try{return(await requestUrl({url:this.settings.serverUrl+"/health",method:"GET"})).status===200}catch{return false}}
  async chk(){try{const r=await requestUrl({url:this.settings.serverUrl+"/health",method:"GET"});if(r.status===200)new Notice("Server OK\n"+r.json.model+"\n"+r.json.device+"\nFeatures: "+(r.json.features||[]).join(", "))}catch{new Notice("Server not reachable.")}}

  private startMeetingPoll(){
    this.stopMeetingPoll();
    this.meetingPollInterval=window.setInterval(()=>{void this.pollForMeeting()},30000);
    // Also do an immediate check after 5 seconds (give Obsidian time to fully load)
    window.setTimeout(()=>{void this.pollForMeeting()},5000);
  }
  private stopMeetingPoll(){
    if(this.meetingPollInterval){clearInterval(this.meetingPollInterval);this.meetingPollInterval=null}
  }
  getPluginDir():string{
    if(this.app.vault.adapter instanceof FileSystemAdapter){
      return this.app.vault.adapter.getBasePath()+"/"+this.app.vault.configDir+"/plugins/"+this.manifest.id;
    }
    return "";
  }
  private resolveCaptureLabel(methods:{sck:boolean;blackhole:boolean}):string{
    if(this.settings.audioCaptureMethod!=="auto")return this.settings.audioCaptureMethod;
    if(methods.sck)return"screencapturekit";
    if(methods.blackhole)return"blackhole";
    return"mic-only";
  }
  private async pollForMeeting(){
    if(this.meetingActive||this.toastShowing||!this.settings.meetingEnabled)return;
    const app=await quickDetectCallApp(this.settings.meetingApps);
    if(app&&app!==this.lastDetectedApp){
      this.lastDetectedApp=app;
      this.toastShowing=true;
      const toast=await showMeetingToast(app,this.settings.toastDismissSeconds);
      this.toastShowing=false;
      if(toast.accepted){
        // Skip the detection step since we already know the app, go straight to modal
        await this.startMeetingWithApp(app);
      }
    }else if(!app){
      this.lastDetectedApp=null;
    }
  }

  private async startMeetingWithApp(appName:string){
    if(this.meetingActive)return;
    if(!(await this.ready())){new Notice("Whisper server not reachable.");return}

    const methods=await SystemAudioCapture.detectAvailableMethods(this.settings.blackholeDeviceName);
    const captureLabel=this.resolveCaptureLabel(methods);

    const modal=new MeetingConfirmModal(this.app,{
      appName,captureMethod:captureLabel,
      diarize:this.settings.diarizeEnabled,postAction:this.settings.meetingPostAction,
    });
    const config=await modal.open();
    if(!config)return;
    await this.launchMeeting(config,appName);
  }

  async startMeeting(){
    if(this.meetingActive){new Notice("Meeting already in progress.");return}
    if(!this.settings.meetingEnabled){new Notice("Meeting mode disabled. Enable in settings.");return}
    if(!(await this.ready())){new Notice("Whisper server not reachable.");return}

    const detection=await detectMeetingApp(this.settings.meetingApps);
    const toast=await showMeetingToast(detection.appName,this.settings.toastDismissSeconds);
    if(!toast.accepted)return;

    const methods=await SystemAudioCapture.detectAvailableMethods(this.settings.blackholeDeviceName);
    const captureLabel=this.resolveCaptureLabel(methods);

    const modal=new MeetingConfirmModal(this.app,{
      appName:detection.appName,
      captureMethod:captureLabel,
      diarize:this.settings.diarizeEnabled,
      postAction:this.settings.meetingPostAction,
    });
    const config=await modal.open();
    if(!config)return;
    await this.launchMeeting(config,detection.appName);
  }

  private async launchMeeting(config:MeetingConfig,appName:string|null){
    this.meetingConfig=config;
    this.meetingAppName=appName;
    this.meetingPcm=[];this.meetingMicPcm=[];this.meetingSysPcm=[];this.meetingPending=[];
    this.meetingPcmSamples=0;this.meetingTexts=[];
    this.meetingChunker=new ChunkSequencer({serverUrl:this.settings.serverUrl,language:this.settings.language,timeoutMs:60000,onText:(t)=>{this.meetingTexts.push(t);const sb=this.getMeetingSidebarView();if(sb)sb.updateTranscript(this.meetingTexts.join(" "))}});
    this.meetingT0=Date.now();this.meetingPaused=false;

    if(this.settings.autoOpenSidebar){
      // Close any existing meeting sidebars first to prevent duplicates
      const existing=this.app.workspace.getLeavesOfType(MEETING_SIDEBAR_TYPE);
      for(const l of existing)l.detach();

      const leaf=this.app.workspace.getRightLeaf(false);
      if(leaf){
        await leaf.setViewState({type:MEETING_SIDEBAR_TYPE,active:true});
        this.app.workspace.revealLeaf(leaf);
        const view=leaf.view;
        if(view instanceof MeetingSidebar){
          view.setCallbacks({
            onStop:()=>{void this.stopMeeting()},
            onPause:()=>{this.meetingPaused=true},
            onResume:()=>{this.meetingPaused=false},
            onMarkMoment:()=>{const sb=this.getMeetingSidebarView();if(sb)sb.addMomentMarker()},
          });
        }
      }
    }

    const pluginDir=this.getPluginDir();
    this.meetingCapture=new SystemAudioCapture({
      onPCMData:(data)=>{
        if(this.meetingPcmSamples<MAX_PCM_SAMPLES){this.meetingPcm.push(data);this.meetingPcmSamples+=data.length}
        if(!this.meetingPaused)this.meetingPending.push(data);
      },
      onMicData:(data)=>{if(this.meetingConfig?.diarize)this.meetingMicPcm.push(data)},
      onSystemData:(data)=>{if(this.meetingConfig?.diarize)this.meetingSysPcm.push(data)},
      onError:(msg)=>{new Notice("Audio error: "+msg)},
      onReady:()=>{},
    },getWorkletUrl(),pluginDir);

    try{
      this.meetingMethod=await this.meetingCapture.start(config.captureMethod,this.settings.blackholeDeviceName);
      this.meetingActive=true;
      const sidebar=this.getMeetingSidebarView();
      if(sidebar)sidebar.startRecording(appName,this.meetingMethod);
      // Use longer chunk interval for meetings (min 7s) to give server time to process
      const meetingInterval=Math.max(this.settings.chunkSeconds,7)*1000;
      this.meetingCI=window.setInterval(()=>this.meetingChunk(),meetingInterval);
      new Notice(`Meeting transcription started (${this.meetingMethod})`);
    }catch(e){new Notice("Failed to start capture: "+e)}
  }

  private meetingChunk(){
    if(this.meetingPending.length===0||this.meetingPaused)return;
    const bufs=[...this.meetingPending];this.meetingPending=[];
    this.meetingChunker?.send(bufs);
  }

  async stopMeeting(){
    if(!this.meetingActive)return;
    if(this.meetingCI){clearInterval(this.meetingCI);this.meetingCI=null}
    if(this.meetingPending.length>0)this.meetingChunk();
    await new Promise(r=>setTimeout(r,200)); // let final chunk request start
    const ws=Date.now();
    while(this.meetingChunker?.hasPending&&Date.now()-ws<5000){await new Promise(r=>setTimeout(r,100))}

    if(this.meetingCapture){await this.meetingCapture.stop();this.meetingCapture=null}
    this.meetingActive=false;

    const msb=this.getMeetingSidebarView();
    if(msb)msb.showProcessing("Processing meeting...");

    try{
      const notePath=await processPostMeeting(this.app,{
        pcmBuffers:this.meetingPcm,
        micPcmBuffers:this.meetingMicPcm,
        sysPcmBuffers:this.meetingSysPcm,
        transcript:this.meetingTexts.join(" "),
        moments:msb?msb.getMoments():[],
        appName:this.meetingAppName,
        captureMethod:this.meetingMethod,
        startTime:this.meetingT0,
        settings:{
          serverUrl:this.settings.serverUrl,notesFolder:this.settings.notesFolder,
          audioFolder:this.settings.audioFolder,aiEnabled:this.settings.aiEnabled,
          aiProvider:this.settings.aiProvider,aiApiKey:this.settings.aiApiKey,
          aiModel:this.settings.aiModel,aiBaseUrl:this.settings.aiBaseUrl,
          aiCustomPrompt:this.settings.aiCustomPrompt,diarizeEnabled:this.settings.diarizeEnabled,
          diarizeNumSpeakers:this.settings.diarizeNumSpeakers,language:this.settings.language,
          whisperModel:this.settings.whisperModel,
        },
        postAction:this.meetingConfig?.postAction||this.settings.meetingPostAction,
        diarize:this.meetingConfig?.diarize||false,
      },(msg)=>{const sb=this.getMeetingSidebarView();if(sb)sb.showProcessing(msg)});

      const sbDone=this.getMeetingSidebarView();
      if(sbDone)sbDone.showComplete(notePath);
      const f=this.app.vault.getAbstractFileByPath(notePath);
      if(f instanceof TFile)await this.app.workspace.getLeaf("tab").openFile(f);
      new Notice("Meeting notes saved!");
    }catch(e){new Notice("Post-meeting processing failed: "+e)}
  }
}

// ═══ Modal ═══
class RecModal extends Modal {
  pl:VoiceNotesPlugin;private str:MediaStream|null=null;private ac:AudioContext|null=null;private wn:AudioWorkletNode|null=null;
  private pcm:Float32Array[]=[];private pend:Float32Array[]=[];private isR=false;private t0=0;
  private ti:number|null=null;private li:number|null=null;private ft="";
  private chunker:ChunkSequencer|null=null;private chunkTexts:string[]=[];private modalDetectedLang="en";
  private tel!:HTMLElement;private txl!:HTMLElement;private rb!:HTMLButtonElement;private sb!:HTMLButtonElement;private svb!:HTMLButtonElement;private aib!:HTMLButtonElement;private stl!:HTMLElement;

  constructor(app:App,pl:VoiceNotesPlugin){super(app);this.pl=pl}

  onOpen(){
    const c=this.contentEl;c.empty();c.addClass("vn-modal");
    c.createEl("h2",{text:"Voice note",cls:"vn-title"});
    this.stl=c.createEl("div",{cls:"vn-status",text:"Ready to record"});
    this.tel=c.createEl("div",{cls:"vn-timer",text:"00:00"});
    const ct=c.createEl("div",{cls:"vn-ctrl"});
    this.rb=ct.createEl("button",{cls:"vn-btn vn-rec",text:"Record"});this.rb.addEventListener("click",()=>{void this.go()});
    this.sb=ct.createEl("button",{cls:"vn-btn vn-stop vn-hidden",text:"Stop"});this.sb.addEventListener("click",()=>{void this.end()});
    this.svb=ct.createEl("button",{cls:"vn-btn vn-save vn-hidden",text:"Save transcript"});this.svb.addEventListener("click",()=>{void this.save(false)});
    this.aib=ct.createEl("button",{cls:"vn-btn vn-ai vn-hidden",text:"Save as meeting notes"});this.aib.addEventListener("click",()=>{void this.save(true)});
    c.createEl("h3",{text:"Transcript"});
    this.txl=c.createEl("div",{cls:"vn-tx",text:"Transcript appears here as you speak..."});
  }
  onClose(){if(this.isR&&this.wn)this.wn.disconnect();if(this.ti)clearInterval(this.ti);if(this.li)clearInterval(this.li);if(this.ac)void this.ac.close();if(this.str)this.str.getTracks().forEach(t=>t.stop())}

  async go(){
    try{
      this.str=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:SR,echoCancellation:true,noiseSuppression:true}});
      this.ac=new AudioContext({sampleRate:SR});
      await this.ac.audioWorklet.addModule(getWorkletUrl());
      const s=this.ac.createMediaStreamSource(this.str);
      this.wn=new AudioWorkletNode(this.ac,"pcm-processor");this.pcm=[];this.pend=[];this.ft="";this.chunkTexts=[];this.modalDetectedLang="en";
      this.chunker=new ChunkSequencer({serverUrl:this.pl.settings.serverUrl,language:this.pl.settings.language,timeoutMs:10000,onText:(t)=>{this.chunkTexts.push(t);this.modalDetectedLang=this.chunker?.detectedLanguage||"en";this.ft=this.chunkTexts.join(" ");this.txl.setText(this.ft);this.txl.scrollTop=this.txl.scrollHeight}});
      this.wn.port.onmessage=(e:MessageEvent)=>{const c=e.data as Float32Array;this.pcm.push(c);this.pend.push(c)};
      s.connect(this.wn);this.isR=true;this.t0=Date.now();
      this.rb.addClass("vn-hidden");this.sb.removeClass("vn-hidden");this.stl.setText("Recording...");
      this.ti=window.setInterval(()=>{const e=Math.floor((Date.now()-this.t0)/1000);this.tel.setText(String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"))},1000);
      this.li=window.setInterval(()=>this.sc(),this.pl.settings.chunkSeconds*1000);
    }catch(e){new Notice("Mic failed: "+e)}
  }

  async end(){
    this.isR=false;if(this.ti)clearInterval(this.ti);if(this.li)clearInterval(this.li);
    if(this.pend.length>0)this.sc();
    const waitStart=Date.now();
    while(this.chunker?.hasPending&&Date.now()-waitStart<5000){await new Promise(r=>setTimeout(r,100))}
    if(this.wn)this.wn.disconnect();if(this.str)this.str.getTracks().forEach(t=>t.stop());
    this.sb.addClass("vn-hidden");this.svb.removeClass("vn-hidden");
    if(this.pl.settings.aiEnabled)this.aib.removeClass("vn-hidden");
    if(this.pl.settings.diarizeEnabled){
      this.stl.setText("Running diarization...");await this.tf();
    }else{
      this.ft=this.chunkTexts.join(" ");
      this.txl.setText(this.ft);this.txl.contentEditable="true";this.txl.addClass("vn-ed");
    }
    this.stl.setText("Done! Edit & save.");
  }

  sc(){
    if(this.pend.length===0)return;const b=[...this.pend];this.pend=[];
    this.chunker?.send(b);
  }

  async tf(){
    const m=mergePCM(this.pcm);
    try{const r=await requestUrl({url:this.pl.settings.serverUrl+"/transcribe",method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({audio_pcm_base64:f32ToB64(m),format:"float32",sample_rate:SR,language:this.pl.settings.language,is_chunk:false,diarize:this.pl.settings.diarizeEnabled,num_speakers:this.pl.settings.diarizeNumSpeakers||null})});
      if(r.status===200){this.ft=r.json.text||"";this.txl.setText(this.ft);this.txl.contentEditable="true";this.txl.addClass("vn-ed")}
    }catch{new Notice("Transcription failed.")}
  }

  async save(ai:boolean){
    const tx=this.txl.textContent||"";if(!tx.trim()){new Notice("No transcript");return}
    let originalTx=tx;let displayTx=tx;
    const srcLang=this.modalDetectedLang||this.pl.settings.language;
    if(this.pl.settings.translateToEnglish&&this.pl.settings.aiEnabled&&srcLang!=="en"&&srcLang!=="auto"){
      this.stl.setText("Translating...");
      try{
        const r=await requestUrl({url:this.pl.settings.serverUrl+"/translate",method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({text:tx,source_language:srcLang,provider:this.pl.settings.aiProvider,api_key:this.pl.settings.aiApiKey,model:this.pl.settings.aiModel,base_url:this.pl.settings.aiBaseUrl})});
        if(r.status===200&&r.json.translation){displayTx=r.json.translation.trim();originalTx=tx}
      }catch(e){console.error("Translation failed:",e)}
    }
    const now=window.moment();const ds=now.format("YYYY-MM-DD");const ts=now.format("HH-mm-ss");const dd=now.format("dddd, Do MMMM YYYY HH:mm");
    const el=Math.floor((Date.now()-this.t0)/1000);const dur=Math.floor(el/60)+"m "+(el%60)+"s";const wc=displayTx.split(/\s+/).filter((w:string)=>w).length;
    const af=this.pl.settings.audioFolder;const afn=`voice-note-${ds}-${ts}.wav`;const ap=`${af}/${afn}`;
    await ensureFolder(this.app,af);const merged=mergePCM(this.pcm);const wavBuf=pcmToWav(merged,SR);
    await this.app.vault.adapter.writeBinary(ap,wavBuf);
    let sum="";
    if(ai&&this.pl.settings.aiEnabled){
      this.stl.setText("Generating meeting notes...");
      try{const r=await requestUrl({url:this.pl.settings.serverUrl+"/summarize",method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({transcript:displayTx,provider:this.pl.settings.aiProvider,api_key:this.pl.settings.aiApiKey,model:this.pl.settings.aiModel,base_url:this.pl.settings.aiBaseUrl,custom_prompt:this.pl.settings.aiCustomPrompt})});
        if(r.status===200&&r.json.summary)sum=r.json.summary;
      }catch(e){new Notice("AI failed: "+e)}
    }
    await ensureFolder(this.app,this.pl.settings.notesFolder);
    const pf=ai?"MTG":"VN";const tp=ai?"meeting-notes":"voice-note";const tg=ai?"  - meeting-notes\n  - ai-generated":"  - voice-note";
    let nc=`---\ncreated: ${now.format("YYYY-MM-DDTHH:mm")}\ntype: ${tp}\ndate: ${ds}\nduration: "${dur}"\nwords: ${wc}\naudio: "[[${afn}]]"\ntags:\n${tg}\n---\n\n# ${ai?"Meeting Notes":"Voice Note"} — ${dd}\n\n> [!info] Details\n> Duration: ${dur} | Words: ${wc}\n> Audio: ![[${afn}]]\n`;
    if(sum)nc+=`\n---\n\n${sum}\n`;
    if(originalTx!==displayTx){
      nc+=`\n---\n\n${displayTx}\n\n> [!note]- Original (${srcLang})\n>\n> ${originalTx.trim().split("\n").join("\n> ")}\n\n---\n\n*[[${ds}]]*\n`;
    }else{
      nc+=`\n---\n\n> [!note]${ai?"-":"+"} Transcript\n>\n> ${tx.trim().split("\n").join("\n> ")}\n\n---\n\n*[[${ds}]]*\n`;
    }
    const np=this.pl.settings.notesFolder+"/"+pf+" - "+ds+" "+ts+".md";
    await this.app.vault.create(np,nc);const f=this.app.vault.getAbstractFileByPath(np);
    if(f instanceof TFile)await this.app.workspace.getLeaf().openFile(f);
    new Notice(ai?"Meeting notes saved!":"Voice note saved!");this.close();
  }
}

// ═══ Settings ═══
class VNSettingsTab extends PluginSettingTab {
  pl:VoiceNotesPlugin;constructor(app:App,pl:VoiceNotesPlugin){super(app,pl);this.pl=pl}
  display(){
    const c=this.containerEl;c.empty();
    new Setting(c).setName("Whisper server").setHeading();
    new Setting(c).setName("Server URL").addText(t=>t.setValue(this.pl.settings.serverUrl).onChange(async v=>{this.pl.settings.serverUrl=v;await this.pl.saveSettings()}));
    new Setting(c).setName("Whisper model").addDropdown(d=>d.addOption("mlx-community/whisper-tiny","Tiny").addOption("mlx-community/whisper-base","Base").addOption("mlx-community/whisper-small","Small").addOption("mlx-community/whisper-medium","Medium").addOption("mlx-community/whisper-large-v3-turbo","Large v3 Turbo (recommended)").addOption("mlx-community/distil-whisper-large-v3","Distil Large v3").setValue(this.pl.settings.whisperModel).onChange(async v=>{this.pl.settings.whisperModel=v;await this.pl.saveSettings()}));
    new Setting(c).setName("Language").addDropdown(d=>d.addOption("en","English").addOption("auto","Auto-detect").addOption("ps","Pashto").addOption("prs","Dari").addOption("ar","Arabic").addOption("ur","Urdu").addOption("fr","French").addOption("de","German").addOption("es","Spanish").addOption("hi","Hindi").addOption("zh","Chinese").setValue(this.pl.settings.language).onChange(async v=>{this.pl.settings.language=v;await this.pl.saveSettings()}));
    new Setting(c).setName("Translate to English").setDesc("Translate non-English speech to English via AI. Requires AI summarization enabled. Original transcript preserved in callout.").addToggle(t=>t.setValue(this.pl.settings.translateToEnglish).onChange(async v=>{this.pl.settings.translateToEnglish=v;await this.pl.saveSettings()}));

    new Setting(c).setName("Dictation").setHeading();
    new Setting(c).setName("Chunk interval (seconds)").setDesc("Lower = faster, higher = more accurate").addSlider(s=>s.setLimits(3,15,1).setValue(this.pl.settings.chunkSeconds).setDynamicTooltip().onChange(async v=>{this.pl.settings.chunkSeconds=v;await this.pl.saveSettings()}));
    new Setting(c).setName("Notes folder").addText(t=>t.setValue(this.pl.settings.notesFolder).onChange(async v=>{this.pl.settings.notesFolder=v;await this.pl.saveSettings()}));
    new Setting(c).setName("Audio folder").setDesc("Where WAV recordings are saved").addText(t=>t.setValue(this.pl.settings.audioFolder).onChange(async v=>{this.pl.settings.audioFolder=v;await this.pl.saveSettings()}));

    new Setting(c).setName("Speaker diarization").setHeading();
    new Setting(c).setName("Enable speaker diarization").setDesc("Identify who spoke when (full recordings only, not live dictation). Requires pyannote + HuggingFace token on server.")
      .addToggle(t=>t.setValue(this.pl.settings.diarizeEnabled).onChange(async v=>{this.pl.settings.diarizeEnabled=v;await this.pl.saveSettings();this.display();}));
    if(this.pl.settings.diarizeEnabled){
      new Setting(c).setName("Number of speakers").setDesc("0 = auto-detect (recommended). Set a number if you know exactly how many speakers.")
        .addSlider(s=>s.setLimits(0,10,1).setValue(this.pl.settings.diarizeNumSpeakers).setDynamicTooltip().onChange(async v=>{this.pl.settings.diarizeNumSpeakers=v;await this.pl.saveSettings();}));
    }

    new Setting(c).setName("AI summarization").setHeading();
    new Setting(c).setName("Enable AI summarization").setDesc("Generate meeting notes from transcripts").addToggle(t=>t.setValue(this.pl.settings.aiEnabled).onChange(async v=>{this.pl.settings.aiEnabled=v;await this.pl.saveSettings();this.display()}));

    if(this.pl.settings.aiEnabled){
      new Setting(c).setName("Provider").addDropdown(d=>d.addOption("anthropic","Anthropic (Claude)").addOption("openai","OpenAI (GPT)").addOption("ollama","Ollama (Local)").setValue(this.pl.settings.aiProvider).onChange(async v=>{this.pl.settings.aiProvider=v;await this.pl.saveSettings();this.display()}));

      if(this.pl.settings.aiProvider==="anthropic"){
        new Setting(c).setName("API key").addText(t=>{t.inputEl.type="password";t.setValue(this.pl.settings.aiApiKey).onChange(async v=>{this.pl.settings.aiApiKey=v;await this.pl.saveSettings()})});
        new Setting(c).setName("Model").setDesc("e.g. claude-sonnet-4-20250514").addText(t=>t.setPlaceholder("claude-sonnet-4-20250514").setValue(this.pl.settings.aiModel).onChange(async v=>{this.pl.settings.aiModel=v;await this.pl.saveSettings()}));
        new Setting(c).setName("Base URL").setDesc("Default: https://api.anthropic.com (change for proxies or custom endpoints)").addText(t=>t.setPlaceholder("https://api.anthropic.com").setValue(this.pl.settings.aiBaseUrl).onChange(async v=>{this.pl.settings.aiBaseUrl=v;await this.pl.saveSettings()}));
      } else if(this.pl.settings.aiProvider==="openai"){
        new Setting(c).setName("API key").addText(t=>{t.inputEl.type="password";t.setValue(this.pl.settings.aiApiKey).onChange(async v=>{this.pl.settings.aiApiKey=v;await this.pl.saveSettings()})});
        new Setting(c).setName("Model").setDesc("e.g. gpt-4o").addText(t=>t.setPlaceholder("gpt-4o").setValue(this.pl.settings.aiModel).onChange(async v=>{this.pl.settings.aiModel=v;await this.pl.saveSettings()}));
        new Setting(c).setName("Base URL").setDesc("Optional, for custom endpoints").addText(t=>t.setPlaceholder("https://api.openai.com").setValue(this.pl.settings.aiBaseUrl).onChange(async v=>{this.pl.settings.aiBaseUrl=v;await this.pl.saveSettings()}));
      } else if(this.pl.settings.aiProvider==="ollama"){
        new Setting(c).setName("Ollama URL").addText(t=>t.setPlaceholder("http://127.0.0.1:11434").setValue(this.pl.settings.aiBaseUrl).onChange(async v=>{this.pl.settings.aiBaseUrl=v;await this.pl.saveSettings()}));
        new Setting(c).setName("Model").setDesc("e.g. llama3.2, mistral").addText(t=>t.setPlaceholder("llama3.2").setValue(this.pl.settings.aiModel).onChange(async v=>{this.pl.settings.aiModel=v;await this.pl.saveSettings()}));
      }
      new Setting(c).setName("Custom prompt").setDesc("Override default. Use {transcript} as placeholder.").addTextArea(t=>{t.inputEl.rows=4;t.inputEl.addClass("vn-textarea-full");t.setPlaceholder("Leave empty for default").setValue(this.pl.settings.aiCustomPrompt).onChange(async v=>{this.pl.settings.aiCustomPrompt=v;await this.pl.saveSettings()})});
    }

    new Setting(c).setName("Status").setHeading();
    new Setting(c).setName("Test connection").addButton(b=>b.setButtonText("Test server").onClick(()=>{void this.pl.chk()}));

    new Setting(c).setName("Meeting mode").setHeading();
    new Setting(c).setName("Enable meeting mode").setDesc("Detect calls and transcribe system audio + mic")
      .addToggle(t=>t.setValue(this.pl.settings.meetingEnabled).onChange(async v=>{this.pl.settings.meetingEnabled=v;await this.pl.saveSettings();this.display()}));

    if(this.pl.settings.meetingEnabled){
      new Setting(c).setName("Audio capture method").setDesc("Auto tries ScreenCaptureKit first, then BlackHole, then mic-only")
        .addDropdown(d=>d.addOption("auto","Auto-detect").addOption("screencapturekit","ScreenCaptureKit (macOS 14+)").addOption("blackhole","BlackHole").setValue(this.pl.settings.audioCaptureMethod)
          .onChange(async v=>{this.pl.settings.audioCaptureMethod=v;await this.pl.saveSettings()}));

      new Setting(c).setName("BlackHole device name").setDesc("Name of BlackHole virtual audio device")
        .addText(t=>t.setValue(this.pl.settings.blackholeDeviceName).onChange(async v=>{this.pl.settings.blackholeDeviceName=v;await this.pl.saveSettings()}));

      new Setting(c).setName("After meeting").setDesc("What to generate when meeting ends")
        .addDropdown(d=>d.addOption("transcript","Transcript only").addOption("summary","AI summary").addOption("full","Full notes + action items")
          .setValue(this.pl.settings.meetingPostAction).onChange(async v=>{this.pl.settings.meetingPostAction=v;await this.pl.saveSettings()}));

      new Setting(c).setName("Toast dismiss (seconds)").addSlider(s=>s.setLimits(5,30,1).setValue(this.pl.settings.toastDismissSeconds).setDynamicTooltip()
        .onChange(async v=>{this.pl.settings.toastDismissSeconds=v;await this.pl.saveSettings()}));

      new Setting(c).setName("Auto-open sidebar").setDesc("Open live transcript panel when meeting starts")
        .addToggle(t=>t.setValue(this.pl.settings.autoOpenSidebar).onChange(async v=>{this.pl.settings.autoOpenSidebar=v;await this.pl.saveSettings()}));

      new Setting(c).setName("Custom meeting apps").setDesc("Comma-separated extra app names to detect (e.g. Lark,Gather)")
        .addText(t=>t.setPlaceholder("Lark,Gather").setValue(this.pl.settings.meetingApps).onChange(async v=>{this.pl.settings.meetingApps=v;await this.pl.saveSettings()}));

      const statusDiv=c.createEl("div",{cls:"vn-meeting-info"});
      statusDiv.setText("Checking audio capture...");
      void SystemAudioCapture.detectAvailableMethods(this.pl.settings.blackholeDeviceName).then(m=>{
        let status="";
        if(m.sck)status+="✅ ScreenCaptureKit available\n";
        else status+="⚠️ ScreenCaptureKit not available (requires macOS 14+)\n";
        if(m.blackhole)status+="✅ BlackHole device detected\n";
        else status+="⚠️ BlackHole not detected — install from https://existential.audio/blackhole/\n";
        status+="ℹ️ Mic-only always available as fallback";
        statusDiv.setText(status);
        statusDiv.addClass("vn-preline");
      }).catch(()=>{});

      let testTimer:number|null=null;
      new Setting(c).setName("Test system audio").addButton(b=>b.setButtonText("Test capture").onClick(async()=>{
        const pd=this.pl.getPluginDir();
        const cap=new SystemAudioCapture({onPCMData:()=>{},onError:(e)=>new Notice("Error: "+e),onReady:()=>{}},getWorkletUrl(),pd);
        try{
          const method=await cap.start(this.pl.settings.audioCaptureMethod,this.pl.settings.blackholeDeviceName);
          new Notice("Capture works! Method: "+method);
          testTimer=window.setTimeout(()=>{void cap.stop();testTimer=null},1000);
        }catch(e){new Notice("Capture failed: "+e)}
      }));
    }
  }
}
