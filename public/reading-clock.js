(function(root){
 class ReadingClock{
  constructor(now=()=>Date.now()){this.now=now;this.total=0;this.since=null;}
  start(){this.total=0;this.since=this.now();}
  pause(){if(this.since!==null){this.total+=Math.max(0,this.now()-this.since);this.since=null;}}
  resume(){if(this.since===null)this.since=this.now();}
  elapsed(){return this.total+(this.since===null?0:Math.max(0,this.now()-this.since));}
 }
 if(typeof module!=='undefined')module.exports={ReadingClock};else root.ReadingClock=ReadingClock;
})(typeof window==='undefined'?globalThis:window);
