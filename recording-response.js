const fs=require('node:fs');
function serveRecording(req,res,file,type){
 const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
 if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
  if(!m[1])start=Math.max(0,size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(Number(m[2]),size-1);}
  if(start>=size||start>end){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}status=206;
 }
 const headers={'Content-Type':type,'Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Length':end-start+1};
 if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
 res.writeHead(status,headers);const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
}
module.exports={serveRecording};
