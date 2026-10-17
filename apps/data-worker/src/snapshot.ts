import { boundedBytes, requireCondition } from './types.ts';
import { safePath } from './archive.ts';

export const SNAPSHOT_COMMIT='f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc';
const prefix=`buildthings-gunny-arcade-${SNAPSHOT_COMMIT}/`;
const decoder=new TextDecoder('utf-8',{fatal:true});

export async function fetchSnapshot(fetcher:typeof fetch=fetch):Promise<Map<string,Uint8Array<ArrayBuffer>>> {
  const response=await fetcher(`https://codeload.github.com/withbuildthings/buildthings-gunny-arcade/tar.gz/${SNAPSHOT_COMMIT}`,{redirect:'error',signal:AbortSignal.timeout(20000)});
  requireCondition(response.ok,503,'snapshot_unavailable');
  const packed=await boundedBytes(new Request('https://snapshot.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),16*1024*1024);
  const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes=await boundedBytes(new Request('https://snapshot.invalid',{method:'POST',body:stream,duplex:'half'} as RequestInit),32*1024*1024);
  const files=new Map<string,Uint8Array<ArrayBuffer>>();
  let offset=0;
  while(offset+512<=bytes.length) {
    const header=bytes.subarray(offset,offset+512);
    if(header.every(byte=>byte===0)) break;
    const text=(start:number,length:number)=>decoder.decode(header.subarray(start,start+length)).replace(/\0.*$/s,'');
    const size=Number.parseInt(text(124,12).trim()||'0',8),type=text(156,1),name=text(0,100),extra=text(345,155),path=extra?`${extra}/${name}`:name;
    let checksum=0;for(let n=0;n<512;n++) checksum+=n>=148&&n<156?32:header[n]!;
    requireCondition(checksum===Number.parseInt(text(148,8).trim(),8) && Number.isSafeInteger(size) && size>=0 && size<=8*1024*1024 && offset+512+size<=bytes.length,422,'invalid_snapshot_tar');
    if(type!=='g') {
      requireCondition(path.startsWith(prefix),422,'invalid_snapshot_root');
      const relative=path.slice(prefix.length).replace(/\/$/,'');
      if((type==='0'||type==='')&&relative) {
        safePath(relative);requireCondition(!files.has(relative)&&files.size<1500,422,'invalid_snapshot_path');
        files.set(relative,bytes.slice(offset+512,offset+512+size));
      } else requireCondition(type==='5',422,'unsupported_snapshot_entry');
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  requireCondition(files.has('src/main.cpp')&&files.has('platformio.ini')&&files.has('diagram.json'),422,'incomplete_snapshot');
  return files;
}
