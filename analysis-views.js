(function(){
  'use strict';
  const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  let drawQueued=false,previewGeometry=null;

  function fit(canvas){const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(r.width*d)),h=Math.max(1,Math.round(r.height*d));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}const ctx=canvas.getContext('2d');ctx.setTransform(d,0,0,d,0,0);return{ctx,w:r.width,h:r.height}}
  function drawGeometry(){
    const canvas=$('geometryCanvas');if(!canvas)return;const {ctx,w,h}=fit(canvas),g=previewGeometry||window.cfdApp.getGeometry(),section=x=>previewGeometry?CFDSectionY(x,previewGeometry):window.cfdApp.sectionY(x);ctx.clearRect(0,0,w,h);
    const pad={l:66,r:34,t:42,b:50},scale=(w-pad.l-pad.r),mid=h*.53,X=x=>pad.l+x*scale,Y=y=>mid-y*scale;
    ctx.font='10px SFMono-Regular,monospace';ctx.lineWidth=1;
    ctx.strokeStyle='rgba(163,193,211,.10)';ctx.fillStyle='#6d8495';
    for(let i=0;i<=10;i++){const x=i/10,xx=X(x);ctx.beginPath();ctx.moveTo(xx,pad.t);ctx.lineTo(xx,h-pad.b);ctx.stroke();ctx.fillText(x.toFixed(1),xx-9,h-24)}
    for(let y=-.15;y<=.151;y+=.05){const yy=Y(y);ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.fillText(y.toFixed(2),8,yy+3)}
    ctx.fillStyle='#879ba8';ctx.fillText('x/c',w-50,h-24);ctx.fillText('y/c',13,pad.t-12);

    const outline=(surface,style,dash=[])=>{ctx.beginPath();for(let i=0;i<=240;i++){const x=i/240,y=surface(x).upper;i?ctx.lineTo(X(x),Y(y)):ctx.moveTo(X(x),Y(y))}for(let i=240;i>=0;i--){const x=i/240;ctx.lineTo(X(x),Y(surface(x).lower))}ctx.closePath();ctx.strokeStyle=style;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([])};
    outline(x=>CFDSectionY(x,CFDDefaultGeometry),'rgba(184,202,214,.48)',[5,4]);
    ctx.beginPath();for(let i=0;i<=240;i++){const x=i/240,y=section(x).upper;i?ctx.lineTo(X(x),Y(y)):ctx.moveTo(X(x),Y(y))}for(let i=240;i>=0;i--){const x=i/240;ctx.lineTo(X(x),Y(section(x).lower))}ctx.closePath();ctx.fillStyle='rgba(80,216,244,.10)';ctx.fill();ctx.strokeStyle='#50d8f4';ctx.lineWidth=1.6;ctx.stroke();
    ctx.beginPath();for(let i=0;i<=240;i++){const x=i/240,s=section(x),y=.5*(s.upper+s.lower);i?ctx.lineTo(X(x),Y(y)):ctx.moveTo(X(x),Y(y))}ctx.strokeStyle='#ffad72';ctx.lineWidth=1.1;ctx.setLineDash([4,3]);ctx.stroke();ctx.setLineDash([]);

    let maxT={v:0,x:0,u:0,l:0},maxC={v:-Infinity,x:0};let area=0,prev=null;
    for(let i=0;i<=500;i++){const x=i/500,s=section(x),t=s.upper-s.lower,c=.5*(s.upper+s.lower);if(t>maxT.v)maxT={v:t,x,u:s.upper,l:s.lower};if(c>maxC.v)maxC={v:c,x};if(prev)area+=.5*(t+prev.t)*(x-prev.x);prev={x,t}}
    const tx=X(maxT.x);ctx.strokeStyle='rgba(255,255,255,.72)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(tx,Y(maxT.l));ctx.lineTo(tx,Y(maxT.u));ctx.stroke();ctx.fillStyle='#e7f0f5';ctx.fillText(`t/c ${(maxT.v*100).toFixed(1)}%`,clamp(tx+7,70,w-130),Y(maxT.u)-7);
    const cx=X(maxC.x),cy=Y(maxC.v);ctx.fillStyle='#ffad72';ctx.beginPath();ctx.arc(cx,cy,3.5,0,Math.PI*2);ctx.fill();ctx.fillText(`camber ${(maxC.v*100).toFixed(1)}%`,clamp(cx+7,70,w-150),cy-7);

    const leCanvas=$('leadingEdgeCanvas'),le=fit(leCanvas),lctx=le.ctx,lw=le.w,lh=le.h;lctx.clearRect(0,0,lw,lh);
    lctx.font='9px SFMono-Regular,monospace';lctx.strokeStyle='rgba(163,193,211,.10)';lctx.fillStyle='#6d8495';lctx.lineWidth=1;
    const IX=x=>22+x/.12*(lw-38),IY=y=>lh*.55-y/.055*(lh-28)/2;
    lctx.beginPath();lctx.moveTo(22,IY(0));lctx.lineTo(lw-16,IY(0));lctx.stroke();lctx.fillText('0%c',16,lh-8);lctx.fillText('12%c',lw-39,lh-8);
    const leLine=(fn,color,dash=[])=>{lctx.beginPath();for(let i=0;i<=100;i++){const x=.12*i/100,s=fn(x);i?lctx.lineTo(IX(x),IY(s.upper)):lctx.moveTo(IX(x),IY(s.upper))}for(let i=100;i>=0;i--){const x=.12*i/100;lctx.lineTo(IX(x),IY(fn(x).lower))}lctx.closePath();lctx.strokeStyle=color;lctx.setLineDash(dash);lctx.stroke();lctx.setLineDash([])};
    leLine(x=>CFDSectionY(x,CFDDefaultGeometry),'rgba(184,202,214,.48)',[4,3]);leLine(section,'#50d8f4');

    $('geomThicknessMetric').textContent=`${(maxT.v*100).toFixed(2)}%`;$('geomCamberMetric').textContent=`${(maxC.v*100).toFixed(2)}% @ ${(maxC.x*100).toFixed(0)}%c`;$('geomAreaMetric').textContent=area.toFixed(4);$('geomLeadingMetric').textContent=`${g.leadingEdge.toFixed(1)}×`;
  }

  function niceExtent(values,includeZero=false){let lo=Math.min(...values),hi=Math.max(...values);if(!Number.isFinite(lo)||!Number.isFinite(hi))return[-1,1];if(includeZero){lo=Math.min(lo,0);hi=Math.max(hi,0)}if(Math.abs(hi-lo)<1e-8){const p=Math.max(Math.abs(hi)*.15,.01);lo-=p;hi+=p}else{const p=(hi-lo)*.12;lo-=p;hi+=p}return[lo,hi]}
  function drawChart(canvas,history,series,opts={}){
    const {ctx,w,h}=fit(canvas),pad={l:62,r:18,t:26,b:42};ctx.clearRect(0,0,w,h);ctx.font='10px SFMono-Regular,monospace';const x0=history.length?history[0].iteration:0,x1=Math.max(x0+100,history.length?history[history.length-1].iteration:100),values=[];
    for(const s of series)for(const d of history){const v=s.get(d);if(Number.isFinite(v)&&(opts.log?v>0:true))values.push(opts.log?Math.log10(v):v)}
    const yd=opts.domain||niceExtent(values,opts.includeZero),plotBottom=h-pad.b,X=x=>pad.l+(x-x0)/(x1-x0)*(w-pad.l-pad.r),Y=v=>{const q=opts.log?Math.log10(Math.max(v,1e-12)):v;return pad.t+(yd[1]-q)/(yd[1]-yd[0])*(plotBottom-pad.t)};
    ctx.strokeStyle='rgba(169,196,216,.14)';ctx.fillStyle='#718899';ctx.lineWidth=1;
    for(let i=0;i<=4;i++){const x=x0+(x1-x0)*i/4,xx=X(x),label=Math.round(x).toString(),tw=ctx.measureText(label).width,tx=clamp(xx-tw/2,pad.l,w-pad.r-tw);ctx.beginPath();ctx.moveTo(xx,pad.t);ctx.lineTo(xx,plotBottom);ctx.stroke();ctx.fillText(label,tx,plotBottom+15)}
    for(let i=0;i<=4;i++){const v=yd[0]+(yd[1]-yd[0])*i/4,yy=pad.t+(4-i)/4*(plotBottom-pad.t),label=opts.log?`1e${v.toFixed(0)}`:v.toFixed(opts.decimals??3),tw=ctx.measureText(label).width;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.fillText(label,Math.max(4,pad.l-8-tw),yy+3)}
    for(const s of series){ctx.beginPath();let started=false;for(const d of history){const v=s.get(d);if(!Number.isFinite(v)||(opts.log&&v<=0)){started=false;continue}const xx=X(d.iteration),yy=Y(v);started?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy);started=true}ctx.strokeStyle=s.color;ctx.lineWidth=1.7;ctx.stroke()}
    ctx.strokeStyle='rgba(190,211,224,.25)';ctx.strokeRect(pad.l+.5,pad.t+.5,w-pad.l-pad.r-1,plotBottom-pad.t-1);ctx.fillStyle='#8ca0ad';ctx.fillText(opts.yLabel||'',pad.l,14);const axis='epoch / iteration',aw=ctx.measureText(axis).width;ctx.fillText(axis,pad.l+(w-pad.l-pad.r-aw)/2,h-5);
  }

  function drawConvergence(){
    if(!$('residualCanvas'))return;const h=window.cfdApp.getHistory(),state=window.cfdApp.getState(),last=h[h.length-1]||{},reference=[...h].reverse().find(d=>d.iteration<=state.iteration-100),clDrift=reference&&Number.isFinite(last.cl)?Math.abs(last.cl-reference.cl):Infinity;
    drawChart($('residualCanvas'),h,[{label:'state update',color:'#50d8f4',get:d=>d.residual}],{log:true,domain:[-7,-1],yLabel:'avg |ΔU|'});
    drawChart($('coefficientCanvas'),h,[{label:'CL',color:'#50d8f4',get:d=>d.cl},{label:'CD',color:'#ffad72',get:d=>d.cd},{label:'Cm',color:'#a78bfa',get:d=>d.cm}],{includeZero:true,yLabel:'coefficient',decimals:3});
    drawChart($('shockHistoryCanvas'),h,[{label:'shock x/c',color:'#ff8a47',get:d=>d.shockX},{label:'Mlocal,max',color:'#59d6a2',get:d=>d.maxMach}],{domain:[0,1.5],yLabel:'x/c  or  Mach',decimals:2});
    $('convEpoch').textContent=state.iteration.toLocaleString();$('convResidual').textContent=state.residual>0?state.residual.toExponential(2):'—';$('convClDrift').textContent=Number.isFinite(clDrift)?clDrift.toExponential(2):'—';
    const status=state.configurationDirty?'格子更新待ち':!state.hasStarted?'待機中':!state.running?'一時停止':!reference?'履歴蓄積中':state.residual<1e-5&&clDrift<.002?'準定常':state.residual<1e-4&&clDrift<.01?'収束傾向':'時間発展中';$('convStatus').textContent=status;$('convCondition').textContent=`M∞ ${state.mach.toFixed(2)} · α ${state.aoa.toFixed(1)}° · t* ${state.time.toFixed(3)}`;
  }

  function queueDraw(){if(drawQueued)return;drawQueued=true;requestAnimationFrame(()=>{drawQueued=false;drawGeometry();drawConvergence()})}
  function initializeViews(){window.addEventListener('cfdgeometrypreview',event=>{previewGeometry=event.detail;drawGeometry()});window.addEventListener('cfdgeometrychange',()=>{previewGeometry=null;drawGeometry()});window.addEventListener('cfdhistory',queueDraw);window.addEventListener('resize',queueDraw);drawGeometry();drawConvergence()}
  if(window.cfdReady)window.cfdReady.then(initializeViews);else initializeViews();
})();
