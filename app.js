window.cfdReady=(async function () {
  'use strict';
  await CFDSolver.initialize();
  const $ = id => document.getElementById(id);
  let solver = new CFDSolver(128, 64);
  let running = true, field = 'mach', speed = 1, lastFrame = 0, lastStep = 0;
  const history=[];let lastHistoryIteration=-10;

  const flowCanvas=$('flowCanvas'), flowCtx=flowCanvas.getContext('2d');
  const cpCanvas=$('cpCanvas'), cpCtx=cpCanvas.getContext('2d');
  const sectionCanvas=$('sectionCanvas'), sectionCtx=sectionCanvas.getContext('2d');
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  function turbo(t){
    t=clamp(t,0,1);
    return [
      clamp(34.61+t*(1172.33+t*(-10793.56+t*(33300.12+t*(-38394.49+t*14825.05)))),0,255),
      clamp(23.31+t*(557.33+t*(1225.33+t*(-3574.96+t*(1584.89+t*269.65)))),0,255),
      clamp(27.2+t*(3211.1+t*(-15327.97+t*(27814+t*(-22569.18+t*6838.66)))),0,255)
    ];
  }
  function diverging(t){t=clamp(t,0,1);if(t<.5){const q=t*2;return[25+q*190,85+q*137,150+q*82]}const q=(t-.5)*2;return[215+q*40,222-q*135,232-q*190]}
  function schlierenColor(t){const q=Math.pow(clamp(t,0,1),.55),g=20+235*q;return[g*.72,g*.90,g]}

  function fit(canvas,ctx){
    const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(r.width*d)),h=Math.max(1,Math.round(r.height*d));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
    ctx.setTransform(d,0,0,d,0,0);return{w:r.width,h:r.height};
  }
  function fieldSpec(){
    if(field==='pressure')return{min:.35,max:1.25,title:'静圧 p / (ρ∞a∞²)',digits:2};
    if(field==='density')return{min:.45,max:1.55,title:'密度 ρ / ρ∞',digits:2};
    if(field==='vorticity')return{min:-8,max:8,title:'渦度 ωc / a∞',digits:1};
    if(field==='mach')return{min:0,max:1.45,title:'局所 Mach 数',digits:2};
    if(field==='schlieren')return{min:0,max:4,title:'Schlieren |∇ρ|（対数表示）',digits:1};
    return{min:0,max:Math.max(1.4,solver.mach*1.65),title:'速度絶対値 |V| / a∞',digits:2};
  }
  const mapX=(x,w)=>(x-solver.xmin)/(solver.xmax-solver.xmin)*w;
  const mapY=(y,h)=>h-(y-solver.ymin)/(solver.ymax-solver.ymin)*h;

  function drawAirfoil(ctx,w,h){
    ctx.save();ctx.beginPath();
    for(let n=0;n<=120;n++){const x=n/120,p=solver.sectionToWorld(x,solver.sectionY(x).upper),X=mapX(p.x,w),Y=mapY(p.y,h);n?ctx.lineTo(X,Y):ctx.moveTo(X,Y)}
    for(let n=120;n>=0;n--){const x=n/120,p=solver.sectionToWorld(x,solver.sectionY(x).lower);ctx.lineTo(mapX(p.x,w),mapY(p.y,h))}
    ctx.closePath();ctx.fillStyle='rgba(4,10,16,.82)';ctx.fill();ctx.strokeStyle='rgba(241,249,252,.96)';ctx.lineWidth=1.25;ctx.stroke();ctx.restore();
  }

  function drawSonicContour(ctx,w,h){
    const nx=solver.nx,ny=solver.ny,M=solver.machField;
    ctx.save();ctx.beginPath();ctx.strokeStyle='rgba(255,244,208,.92)';ctx.lineWidth=1.15;ctx.setLineDash([3,2]);
    for(let j=0;j<ny-1;j++)for(let i=0;i<nx;i++){
      const ip=(i+1)%nx,ids=[solver.idx(i,j),solver.idx(ip,j),solver.idx(ip,j+1),solver.idx(i,j+1)],vals=ids.map(k=>M[k]-1),pts=[];
      const edges=[[0,1],[1,2],[2,3],[3,0]];
      for(const [a,b] of edges){const va=vals[a],vb=vals[b];if((va<=0&&vb>0)||(va>0&&vb<=0)){const t=va/(va-vb),x=solver.cellX[ids[a]]+t*(solver.cellX[ids[b]]-solver.cellX[ids[a]]),y=solver.cellY[ids[a]]+t*(solver.cellY[ids[b]]-solver.cellY[ids[a]]);pts.push([mapX(x,w),mapY(y,h)])}}
      if(pts.length>=2){ctx.moveTo(pts[0][0],pts[0][1]);ctx.lineTo(pts[1][0],pts[1][1])}
    }
    ctx.stroke();ctx.restore();
  }

  function drawGridOverlay(ctx,w,h){
    const radial=[0,1,2,4,8,16,32,48,72,96,solver.ny].filter((v,i,a)=>v<=solver.ny&&a.indexOf(v)===i);
    ctx.save();ctx.strokeStyle='rgba(220,239,248,.055)';ctx.lineWidth=.65;
    for(const j of radial){ctx.beginPath();for(let i=0;i<=solver.nx;i++){const k=solver.nodeIdx(i%solver.nx,j),x=mapX(solver.nodeX[k],w),y=mapY(solver.nodeY[k],h);i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.stroke()}
    for(let i=0;i<solver.nx;i+=16){ctx.beginPath();for(let j=0;j<=solver.ny;j++){const k=solver.nodeIdx(i,j),x=mapX(solver.nodeX[k],w),y=mapY(solver.nodeY[k],h);j?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.stroke()}
    ctx.restore();
  }

  function updateShockBadge(size){
    const d=solver.diagnostics,b=$('shockBadge');
    b.classList.toggle('hidden',!d.shockDetected);
    if(!d.shockDetected)return;
    const surf=solver.sectionY(d.shockX),p=solver.sectionToWorld(d.shockX,surf.upper+.055),left=clamp(mapX(p.x,size.w)/size.w*100,8,86),top=clamp(mapY(p.y,size.h)/size.h*100-9,3,72);
    b.textContent=`SHOCK · x/c ${d.shockX.toFixed(2)}`;b.style.left=`${left}%`;b.style.top=`${top}%`;b.style.right='auto';
  }

  function drawFlow(){
    const size=fit(flowCanvas,flowCtx),sp=fieldSpec();solver.updateDerivedFields();
    const bins=56,paths=typeof Path2D==='function'?Array.from({length:bins},()=>new Path2D()):null;
    flowCtx.clearRect(0,0,size.w,size.h);flowCtx.fillStyle='#07131f';flowCtx.fillRect(0,0,size.w,size.h);
    for(let j=0;j<solver.ny;j++)for(let i=0;i<solver.nx;i++){
      const k=solver.idx(i,j),q=solver.primitive(k);let v;
      if(field==='pressure')v=q[3];else if(field==='density')v=q[0];else if(field==='vorticity')v=solver.vorticity[k];else if(field==='mach')v=solver.machField[k];else if(field==='schlieren')v=solver.schlieren[k];else v=Math.hypot(q[1],q[2]);
      const t=clamp((v-sp.min)/(sp.max-sp.min),0,1),bin=Math.min(bins-1,Math.floor(t*bins)),ip=(i+1)%solver.nx,ids=[solver.nodeIdx(i,j),solver.nodeIdx(ip,j),solver.nodeIdx(ip,j+1),solver.nodeIdx(i,j+1)];
      const addPath=path=>{path.moveTo(mapX(solver.nodeX[ids[0]],size.w),mapY(solver.nodeY[ids[0]],size.h));for(let n=1;n<4;n++)path.lineTo(mapX(solver.nodeX[ids[n]],size.w),mapY(solver.nodeY[ids[n]],size.h));path.closePath()};
      if(paths)addPath(paths[bin]);else{flowCtx.beginPath();addPath(flowCtx);const rgb=field==='vorticity'?diverging(t):field==='schlieren'?schlierenColor(t):turbo(t);flowCtx.fillStyle=`rgb(${rgb[0]|0},${rgb[1]|0},${rgb[2]|0})`;flowCtx.fill()}
    }
    if(paths)for(let b=0;b<bins;b++){const t=(b+.5)/bins,rgb=field==='vorticity'?diverging(t):field==='schlieren'?schlierenColor(t):turbo(t);flowCtx.fillStyle=`rgb(${rgb[0]|0},${rgb[1]|0},${rgb[2]|0})`;flowCtx.fill(paths[b])}
    drawGridOverlay(flowCtx,size.w,size.h);drawSonicContour(flowCtx,size.w,size.h);drawAirfoil(flowCtx,size.w,size.h);updateShockBadge(size);
    $('fieldTitle').textContent=sp.title;$('legendMin').textContent=sp.min.toFixed(sp.digits);$('legendMax').textContent=sp.max.toFixed(sp.digits);
  }

  function drawColorbar(){
    const c=$('colorbar'),x=c.getContext('2d'),im=x.createImageData(c.width,c.height);
    for(let i=0;i<c.width;i++){const rgb=field==='vorticity'?diverging(i/(c.width-1)):field==='schlieren'?schlierenColor(i/(c.width-1)):turbo(i/(c.width-1));for(let j=0;j<c.height;j++){const k=4*(i+j*c.width);im.data[k]=rgb[0];im.data[k+1]=rgb[1];im.data[k+2]=rgb[2];im.data[k+3]=255}}
    x.putImageData(im,0,0);
  }

  function drawCp(){
    const z=fit(cpCanvas,cpCtx),ctx=cpCtx,w=z.w,h=z.h,p={l:44,r:14,t:15,b:25};ctx.clearRect(0,0,w,h);
    const all=[...solver.cp.upper,...solver.cp.lower],lo=Math.min(-1.2,...all),hi=Math.max(.8,...all),mn=Math.floor(lo*2)/2,mx=Math.ceil(hi*2)/2,X=q=>p.l+q*(w-p.l-p.r),Y=q=>p.t+(q-mn)/(mx-mn)*(h-p.t-p.b);
    ctx.strokeStyle='rgba(170,200,219,.12)';ctx.lineWidth=1;ctx.font='9px SFMono-Regular,monospace';ctx.fillStyle='#6e8799';
    for(let q=0;q<=4;q++){const v=q/4,xx=X(v);ctx.beginPath();ctx.moveTo(xx,p.t);ctx.lineTo(xx,h-p.b);ctx.stroke();ctx.fillText(v.toFixed(2),xx-10,h-8)}
    for(let q=0;q<=4;q++){const v=mn+(mx-mn)*q/4,yy=Y(v);ctx.beginPath();ctx.moveTo(p.l,yy);ctx.lineTo(w-p.r,yy);ctx.stroke();ctx.fillText(v.toFixed(1),5,yy+3)}
    const line=(arr,col)=>{ctx.beginPath();arr.forEach((v,i)=>{const xx=X(solver.cp.x[i]||0),yy=Y(v);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.stroke()};
    line(solver.cp.upper,'#50d8f4');line(solver.cp.lower,'#ff8a47');
    if(solver.diagnostics.shockDetected){const xx=X(solver.diagnostics.shockX);ctx.strokeStyle='rgba(255,244,208,.7)';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(xx,p.t);ctx.lineTo(xx,h-p.b);ctx.stroke();ctx.setLineDash([])}
    ctx.fillStyle='#8ba0ae';ctx.fillText('x/c',w-29,h-8);ctx.fillText('Cp',10,13);
  }

  function drawSection(){
    const z=fit(sectionCanvas,sectionCtx),ctx=sectionCtx,w=z.w,h=z.h,X=q=>25+q*(w-50),Y=q=>h*.57-q*(w-50);ctx.clearRect(0,0,w,h);
    ctx.strokeStyle='rgba(174,198,214,.15)';ctx.beginPath();ctx.moveTo(25,h*.57);ctx.lineTo(w-25,h*.57);ctx.stroke();ctx.beginPath();
    for(let n=0;n<=100;n++){const q=n/100,y=solver.sectionY(q).upper;n?ctx.lineTo(X(q),Y(y)):ctx.moveTo(X(q),Y(y))}for(let n=100;n>=0;n--){const q=n/100;ctx.lineTo(X(q),Y(solver.sectionY(q).lower))}
    ctx.closePath();ctx.fillStyle='rgba(80,216,244,.06)';ctx.fill();ctx.strokeStyle='#9db3c2';ctx.lineWidth=1.2;ctx.stroke();
    const cp=Number.isFinite(solver.coeffs.cp)?solver.coeffs.cp:Math.abs(solver.coeffs.cl)>.05?.25+solver.coeffs.cm/solver.coeffs.cl:NaN;if(Number.isFinite(cp)&&cp>=0&&cp<=1){const xx=X(cp);ctx.strokeStyle='#50d8f4';ctx.beginPath();ctx.moveTo(xx,18);ctx.lineTo(xx,h-13);ctx.stroke();ctx.fillStyle='#50d8f4';ctx.beginPath();ctx.arc(xx,Y(0),4,0,Math.PI*2);ctx.fill();ctx.font='9px SFMono-Regular,monospace';ctx.fillText('x_cp',clamp(xx-12,5,w-30),13)}
  }

  function updateUI(){
    const c=solver.coeffs,cp=Number.isFinite(c.cp)?c.cp:Math.abs(c.cl)>.05?.25+c.cm/c.cl:NaN,d=solver.diagnostics,quality=d.cpRoughnessRaw>0?Math.max(0,1-d.cpRoughnessFiltered/d.cpRoughnessRaw):0;if($("cpQuality"))$("cpQuality").textContent="局所平滑 −"+Math.round(quality*100)+"%";$('clValue').textContent=c.cl.toFixed(3);$('cdValue').textContent=c.cd.toFixed(3);$('cmValue').textContent=c.cm.toFixed(3);$('cpValue').textContent=Number.isFinite(cp)?cp.toFixed(3):'—';$('cpReadout').textContent=Number.isFinite(cp)?`x/c = ${cp.toFixed(3)}${cp<0||cp>1?' · 翼弦外':''}`:'Cl不足';
    $('cflText').textContent=`CFL ${solver.cfl.toFixed(2)}`;if($('modelLine')){const engine=solver.backend==='cpp-wasm'?'C++/WebAssembly':'JavaScript fallback';$('modelLine').textContent=`翼面適合O格子 · ${solver.nx} × ${solver.ny} · ${engine} · HLL有限体積法 · Re = 50,000 · γ = 1.4`;}$('iterationText').textContent=`ITER ${solver.iteration.toLocaleString()} · t* ${solver.time.toFixed(3)}`;$('residualText').textContent=`ΔU ${solver.residual.toExponential(2)}`;$('flowSubtitle').textContent=`M∞ ${solver.mach.toFixed(2)} · α ${solver.aoa}° · Mlocal,max ${d.maxSurfaceMach.toFixed(2)}`;
  }
  function recordHistory(force=false){if(!force&&solver.iteration-lastHistoryIteration<10)return;lastHistoryIteration=solver.iteration;const d=solver.diagnostics,c=solver.coeffs;history.push({iteration:solver.iteration,time:solver.time,residual:solver.residual,cl:c.cl,cd:c.cd,cm:c.cm,shockX:d.shockDetected?d.shockX:NaN,maxMach:d.maxSurfaceMach});if(history.length>2400)history.splice(0,history.length-2400);window.dispatchEvent(new Event('cfdhistory'));}
  function clearHistory(){history.length=0;lastHistoryIteration=-10;recordHistory(true);}
  function render(){drawFlow();drawCp();drawSection();updateUI()}
  function loop(t){const stepInterval=120/speed;if(running&&t-lastStep>=stepInterval){solver.step();lastStep=t;recordHistory();}if(t-lastFrame>160){render();lastFrame=t}requestAnimationFrame(loop)}
  function reset(){solver.reset(+$('machSlider').value,+$('aoaSlider').value);clearHistory();render()}
  $('aoaSlider').addEventListener('input',e=>{$('aoaOutput').textContent=`${e.target.value}°`;reset()});
  $('machSlider').addEventListener('input',e=>{$('machOutput').textContent=(+e.target.value).toFixed(2);reset()});
  $('resetButton').addEventListener('click',reset);$('speedSelect').addEventListener('change',e=>speed=+e.target.value);$('gridSelect').addEventListener('change',e=>{const [nx,ny]=e.target.value.split('x').map(Number),geometry={...solver.geometry},mach=+$('machSlider').value,aoa=+$('aoaSlider').value;solver=new CFDSolver(nx,ny);solver.geometry=geometry;solver.reset(mach,aoa);lastStep=0;clearHistory();render()});
  $('playButton').addEventListener('click',()=>{running=!running;$('playIcon').textContent=running?'Ⅱ':'▶';$('playLabel').textContent=running?'一時停止':'計算を再開';$('statusText').textContent=running?'計算中':'一時停止';$('statusDot').classList.toggle('paused',!running)});
  document.querySelectorAll('[data-field]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-field]').forEach(q=>q.classList.remove('active'));b.classList.add('active');field=b.dataset.field;drawColorbar();render()}));
  window.cfdApp={setGeometry:p=>{solver.setGeometry(p);clearHistory();render();},getGeometry:()=>({...solver.geometry}),sectionY:x=>solver.sectionY(x),getHistory:()=>history.slice(),getState:()=>({iteration:solver.iteration,time:solver.time,residual:solver.residual,mach:solver.mach,aoa:solver.aoa,running,backend:solver.backend})};
  window.addEventListener('resize',render);$('statusText').textContent='計算中';drawColorbar();render();clearHistory();requestAnimationFrame(loop);
})();
