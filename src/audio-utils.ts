import {App} from "obsidian";

export function mergePCM(bufs:Float32Array[]):Float32Array{
  const t=bufs.reduce((s,b)=>s+b.length,0);
  const o=new Float32Array(t);let off=0;
  for(const b of bufs){o.set(b,off);off+=b.length}
  return o;
}

export function f32ToB64(arr:Float32Array):string{
  const b=new Uint8Array(arr.buffer,arr.byteOffset,arr.byteLength);
  const chunks:string[]=[];const BLOCK=8192;
  for(let i=0;i<b.byteLength;i+=BLOCK){
    const slice=b.subarray(i,Math.min(i+BLOCK,b.byteLength));
    chunks.push(String.fromCharCode.apply(null,Array.from(slice)));
  }
  return btoa(chunks.join(""));
}

export function pcmToWav(samples:Float32Array,sampleRate:number):ArrayBuffer{
  const numChannels=1;const bitsPerSample=16;
  const byteRate=sampleRate*numChannels*bitsPerSample/8;
  const blockAlign=numChannels*bitsPerSample/8;
  const dataSize=samples.length*blockAlign;
  const buffer=new ArrayBuffer(44+dataSize);
  const view=new DataView(buffer);
  function writeStr(o:number,s:string){for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i))}
  writeStr(0,"RIFF");view.setUint32(4,36+dataSize,true);writeStr(8,"WAVE");
  writeStr(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);
  view.setUint16(22,numChannels,true);view.setUint32(24,sampleRate,true);
  view.setUint32(28,byteRate,true);view.setUint16(32,blockAlign,true);
  view.setUint16(34,bitsPerSample,true);writeStr(36,"data");view.setUint32(40,dataSize,true);
  let offset=44;
  for(let i=0;i<samples.length;i++){
    const s=Math.max(-1,Math.min(1,samples[i]));
    view.setInt16(offset,s<0?s*0x8000:s*0x7FFF,true);offset+=2;
  }
  return buffer;
}

export async function ensureFolder(app:App,p:string){
  const parts=p.split("/");let c="";
  for(const part of parts){
    c=c?c+"/"+part:part;
    if(!(await app.vault.adapter.exists(c)))await app.vault.createFolder(c);
  }
}
