window.cfdReady=(async function () {
  'use strict';
  await CFDSolver.initialize();
  const $ = id => document.getElementById(id);
  let solver = new CFDSolver(128, 64), stagedGeometry={...solver.geometry};
  let running = false, hasStarted = false, configurationDirty = false, field = 'mach', speed = 1, lastFrame = 0, lastStep = 0, parameterDragging = false;
  const history=[];let lastHistoryIteration=-10;

  const flowCanvas=$('flowCanvas'), flowCtx=flowCanvas.getContext('2d');
  const cpCanvas=$('cpCanvas'), cpCtx=cpCanvas.getContext('2d');
  const sectionCanvas=$('sectionCanvas'), sectionCtx=sectionCanvas.getContext('2d');
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  // スライダーは log10(Re)。仮数を1桁に丸めて 1.0/1.3/…/7.9 ×10^k のきりのよい値だけを返す。
  const reynoldsFromSlider=v=>{const e=Math.floor(v);return Math.round(Math.pow(10,v-e)*10)/10*Math.pow(10,e)};

  function turbo(t){
    t=clamp(t,0,1);
    return [
      clamp(34.61+t*(1172.33+t*(-10793.56+t*(33300.12+t*(-38394.49+t*14825.05)))),0,255),
      clamp(23.31+t*(557.33+t*(1225.33+t*(-3574.96+t*(1584.89+t*269.65)))),0,255),
      clamp(27.2+t*(3211.1+t*(-15327.97+t*(27814+t*(-22569.18+t*6838.66)))),0,255)
    ];
  }
  function schlierenColor(t){const q=Math.pow(clamp(t,0,1),.55),g=20+235*q;return[g*.72,g*.90,g]}

  function fit(canvas,ctx){
    const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(r.width*d)),h=Math.max(1,Math.round(r.height*d));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
    ctx.setTransform(d,0,0,d,0,0);return{w:r.width,h:r.height};
  }
  function fieldSpec(){
    if(field==='pressure')return{min:.35,max:1.25,title:'静圧 p / (ρ∞a∞²)',digits:2};
    if(field==='density')return{min:.45,max:1.55,title:'密度 ρ / ρ∞',digits:2};
    if(field==='mach')return{min:0,max:1.45,title:'局所 Mach 数',digits:2};
    if(field==='streamlines')return{min:0,max:Math.max(1.45,solver.mach*1.65),title:'流線 · 色は局所 Mach 数',digits:2};
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

  function velocitySampler(){
    const cols=72,rows=40,n=cols*rows,su=new Float32Array(n),sv=new Float32Array(n),sm=new Float32Array(n),count=new Uint16Array(n),dx=solver.xmax-solver.xmin,dy=solver.ymax-solver.ymin;
    for(let k=0;k<solver.n;k++){const ix=clamp(Math.floor((solver.cellX[k]-solver.xmin)/dx*cols),0,cols-1),iy=clamp(Math.floor((solver.cellY[k]-solver.ymin)/dy*rows),0,rows-1),q=ix+iy*cols;su[q]+=solver.uField[k];sv[q]+=solver.vField[k];sm[q]+=solver.machField[k];count[q]++}
    for(let q=0;q<n;q++)if(count[q]){su[q]/=count[q];sv[q]/=count[q];sm[q]/=count[q]}
    for(let pass=0;pass<3;pass++){const nu=su.slice(),nv=sv.slice(),nm=sm.slice(),nc=count.slice();for(let iy=1;iy<rows-1;iy++)for(let ix=1;ix<cols-1;ix++){const q=ix+iy*cols;if(count[q])continue;let u=0,v=0,m=0,c=0;for(const d of [-1,1,-cols,cols])if(count[q+d]){u+=su[q+d];v+=sv[q+d];m+=sm[q+d];c++}if(c){nu[q]=u/c;nv[q]=v/c;nm[q]=m/c;nc[q]=1}}su.set(nu);sv.set(nv);sm.set(nm);count.set(nc)}
    return(x,y)=>{const gx=(x-solver.xmin)/dx*(cols-1),gy=(y-solver.ymin)/dy*(rows-1);if(gx<0||gy<0||gx>=cols-1||gy>=rows-1)return null;const ix=Math.floor(gx),iy=Math.floor(gy),tx=gx-ix,ty=gy-iy;let u=0,v=0,m=0,w=0;for(const [ox,oy,z] of [[0,0,(1-tx)*(1-ty)],[1,0,tx*(1-ty)],[0,1,(1-tx)*ty],[1,1,tx*ty]]){const q=ix+ox+(iy+oy)*cols;if(!count[q])continue;u+=z*su[q];v+=z*sv[q];m+=z*sm[q];w+=z}return w>.15?[u/w,v/w,m/w]:null};
  }
  function worldToSection(x,y){const a=-solver.aoa*Math.PI/180,c=Math.cos(a),sn=Math.sin(a),wx=x-.25;return{x:.25+wx*c+y*sn,y:-wx*sn+y*c}}
  function insideFlowDomain(x,y){const p=worldToSection(x,y),ex=(p.x-.5)/1.55,ey=p.y;return ex*ex+ey*ey<=1+1e-6}
  function insideAirfoil(x,y){const a=-solver.aoa*Math.PI/180,c=Math.cos(a),s=Math.sin(a),wx=x-.25,sx=.25+wx*c+y*s,sy=-wx*s+y*c;if(sx<0||sx>1)return false;const section=solver.sectionY(sx);return sy>section.lower&&sy<section.upper}
  function drawStreamlines(ctx,w,h,minMach,maxMach){
    ctx.save();let outerYMin=Infinity,outerYMax=-Infinity;ctx.beginPath();for(let i=0;i<=solver.nx;i++){const k=solver.nodeIdx(i%solver.nx,solver.ny),x=mapX(solver.nodeX[k],w),y=mapY(solver.nodeY[k],h);i?ctx.lineTo(x,y):ctx.moveTo(x,y);if(i<solver.nx){outerYMin=Math.min(outerYMin,solver.nodeY[k]);outerYMax=Math.max(outerYMax,solver.nodeY[k])}}ctx.closePath();ctx.clip();
    const upstreamX=y=>{let left=Infinity;for(let i=0;i<solver.nx;i++){const a=solver.nodeIdx(i,solver.ny),b=solver.nodeIdx(i+1,solver.ny),ya=solver.nodeY[a],yb=solver.nodeY[b];if(!((ya<=y&&y<yb)||(yb<=y&&y<ya)))continue;const t=(y-ya)/(yb-ya),x=solver.nodeX[a]+t*(solver.nodeX[b]-solver.nodeX[a]);left=Math.min(left,x)}return left};
    const sample=velocitySampler(),span=solver.xmax-solver.xmin,step=span/210,seeds=25,bins=36,paths=typeof Path2D==='function'?Array.from({length:bins},()=>new Path2D()):null,arrows=[],color=mach=>{const rgb=turbo(clamp((mach-minMach)/Math.max(maxMach-minMach,1e-6),0,1));return`rgb(${rgb[0]|0},${rgb[1]|0},${rgb[2]|0})`};ctx.save();ctx.lineWidth=1.15;ctx.lineCap='round';
    for(let seed=0;seed<seeds;seed++){let y=outerYMin+(outerYMax-outerYMin)*(.12+.76*seed/(seeds-1)),x=upstreamX(y);if(!Number.isFinite(x))continue;x+=step*.75;if(!insideFlowDomain(x,y))continue;const points=[];for(let n=0;n<260;n++){const q=sample(x,y);if(!q)break;const speed=Math.hypot(q[0],q[1]);if(speed<1e-4)break;const mx=x+.5*step*q[0]/speed,my=y+.5*step*q[1]/speed,m=sample(mx,my)||q,ms=Math.max(Math.hypot(m[0],m[1]),1e-6),nx=x+step*m[0]/ms,ny=y+step*m[1]/ms;if(!insideFlowDomain(nx,ny)||insideAirfoil(nx,ny))break;points.push([mapX(nx,w),mapY(ny,h),m[2]]);x=nx;y=ny}if(points.length<2)continue;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],mach=.5*(a[2]+b[2]),bin=Math.min(bins-1,Math.floor(clamp((mach-minMach)/Math.max(maxMach-minMach,1e-6),0,1)*bins));if(paths){paths[bin].moveTo(a[0],a[1]);paths[bin].lineTo(b[0],b[1])}else{ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.strokeStyle=color(mach);ctx.stroke()}}if(seed%2===0){const i=Math.floor(points.length*.55),a=points[Math.max(0,i-1)],b=points[i];arrows.push({x:b[0],y:b[1],a:Math.atan2(b[1]-a[1],b[0]-a[0]),mach:b[2]})}}
    if(paths)for(let bin=0;bin<bins;bin++){const mach=minMach+(bin+.5)/bins*(maxMach-minMach);ctx.strokeStyle=color(mach);ctx.stroke(paths[bin])}for(const arrow of arrows){ctx.save();ctx.translate(arrow.x,arrow.y);ctx.rotate(arrow.a);ctx.fillStyle=color(arrow.mach);ctx.beginPath();ctx.moveTo(4.5,0);ctx.lineTo(-3.2,-2.6);ctx.lineTo(-3.2,2.6);ctx.closePath();ctx.fill();ctx.restore()}ctx.restore();ctx.restore();
  }

  function updateShockBadge(size){
    const d=solver.diagnostics,b=$('shockBadge');
    b.classList.toggle('hidden',!d.shockDetected);
    if(!d.shockDetected)return;
    const surf=solver.sectionY(d.shockX),p=solver.sectionToWorld(d.shockX,surf.upper+.055),left=clamp(mapX(p.x,size.w)/size.w*100,8,86),top=clamp(mapY(p.y,size.h)/size.h*100-9,3,72);
    b.textContent=`SHOCK · x/c ${d.shockX.toFixed(2)}`;b.style.left=`${left}%`;b.style.top=`${top}%`;b.style.right='auto';
  }

  function drawFlow(){
    const size=fit(flowCanvas,flowCtx),sp=fieldSpec(),streamlineMode=field==='streamlines';solver.updateDerivedFields();flowCtx.clearRect(0,0,size.w,size.h);flowCtx.fillStyle='#07131f';flowCtx.fillRect(0,0,size.w,size.h);
    if(streamlineMode){drawStreamlines(flowCtx,size.w,size.h,sp.min,sp.max)}else{const bins=56,paths=typeof Path2D==='function'?Array.from({length:bins},()=>new Path2D()):null;for(let j=0;j<solver.ny;j++)for(let i=0;i<solver.nx;i++){const k=solver.idx(i,j),q=solver.primitive(k);let v;if(field==='pressure')v=q[3];else if(field==='density')v=q[0];else if(field==='mach')v=solver.machField[k];else if(field==='schlieren')v=solver.schlieren[k];else v=Math.hypot(q[1],q[2]);const t=clamp((v-sp.min)/(sp.max-sp.min),0,1),bin=Math.min(bins-1,Math.floor(t*bins)),ip=(i+1)%solver.nx,ids=[solver.nodeIdx(i,j),solver.nodeIdx(ip,j),solver.nodeIdx(ip,j+1),solver.nodeIdx(i,j+1)],addPath=path=>{path.moveTo(mapX(solver.nodeX[ids[0]],size.w),mapY(solver.nodeY[ids[0]],size.h));for(let n=1;n<4;n++)path.lineTo(mapX(solver.nodeX[ids[n]],size.w),mapY(solver.nodeY[ids[n]],size.h));path.closePath()};if(paths)addPath(paths[bin]);else{flowCtx.beginPath();addPath(flowCtx);const rgb=field==='schlieren'?schlierenColor(t):turbo(t);flowCtx.fillStyle=`rgb(${rgb[0]|0},${rgb[1]|0},${rgb[2]|0})`;flowCtx.fill()}}if(paths)for(let b=0;b<bins;b++){const t=(b+.5)/bins,rgb=field==='schlieren'?schlierenColor(t):turbo(t);flowCtx.fillStyle=`rgb(${rgb[0]|0},${rgb[1]|0},${rgb[2]|0})`;flowCtx.fill(paths[b])}drawGridOverlay(flowCtx,size.w,size.h);drawSonicContour(flowCtx,size.w,size.h)}
    drawAirfoil(flowCtx,size.w,size.h);if(streamlineMode)$('shockBadge').classList.add('hidden');else updateShockBadge(size);$('overlayText').textContent=streamlineMode?'流線色: 局所 Mach 数':'白破線: M = 1';$('fieldTitle').textContent=sp.title;$('legendMin').textContent=sp.min.toFixed(sp.digits);$('legendMax').textContent=sp.max.toFixed(sp.digits);
  }

  function drawColorbar(){
    const c=$('colorbar'),x=c.getContext('2d'),im=x.createImageData(c.width,c.height);
    for(let i=0;i<c.width;i++){const rgb=field==='schlieren'?schlierenColor(i/(c.width-1)):turbo(i/(c.width-1));for(let j=0;j<c.height;j++){const k=4*(i+j*c.width);im.data[k]=rgb[0];im.data[k+1]=rgb[1];im.data[k+2]=rgb[2];im.data[k+3]=255}}
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
    const cp=Number.isFinite(solver.coeffs.cp)?solver.coeffs.cp:Math.abs(solver.coeffs.cl)>.05?.25-solver.coeffs.cm/solver.coeffs.cl:NaN;if(Number.isFinite(cp)&&cp>=0&&cp<=1){const xx=X(cp);ctx.strokeStyle='#50d8f4';ctx.beginPath();ctx.moveTo(xx,18);ctx.lineTo(xx,h-13);ctx.stroke();ctx.fillStyle='#50d8f4';ctx.beginPath();ctx.arc(xx,Y(0),4,0,Math.PI*2);ctx.fill();ctx.font='9px SFMono-Regular,monospace';ctx.fillText('x_cp',clamp(xx-12,5,w-30),13)}
  }

  function updateUI(){
    const c=solver.coeffs,cp=Number.isFinite(c.cp)?c.cp:Math.abs(c.cl)>.05?.25-c.cm/c.cl:NaN,d=solver.diagnostics,quality=d.cpRoughnessRaw>0?Math.max(0,1-d.cpRoughnessFiltered/d.cpRoughnessRaw):0;if($("cpQuality"))$("cpQuality").textContent="局所平滑 −"+Math.round(quality*100)+"%";$('clValue').textContent=c.cl.toFixed(3);$('cdValue').textContent=c.cd.toFixed(3);if($('cdBreakdown'))$('cdBreakdown').textContent=`圧力 ${Math.max(c.cdPressure,0).toFixed(4)}\n摩擦 ${c.cdFriction.toFixed(4)}`;$('cmValue').textContent=c.cm.toFixed(3);$('cpValue').textContent=Number.isFinite(cp)?cp.toFixed(3):'—';$('cpReadout').textContent=Number.isFinite(cp)?`x/c = ${cp.toFixed(3)}${cp<0||cp>1?' · 翼弦外':''}`:'Cl不足';
    $('cflText').textContent=`CFL ${solver.cfl.toFixed(2)}`;if($('modelLine')){const engine=solver.backend==='cpp-wasm'?'C++/WebAssembly':'JavaScript fallback';$('modelLine').textContent=`翼面適合O格子 · ${solver.nx} × ${solver.ny} · ${engine} · HLL有限体積法 · Re = ${Math.round(solver.reynolds).toLocaleString()} · 摩擦 ${CFDFrictionModels[solver.frictionModel].label} · γ = 1.4`;}$('iterationText').textContent=`ITER ${solver.iteration.toLocaleString()} · t* ${solver.time.toFixed(3)}`;$('residualText').textContent=`ΔU ${solver.residual.toExponential(2)}`;$('flowSubtitle').textContent=`M∞ ${solver.mach.toFixed(2)} · α ${solver.aoa.toFixed(1)}° · Mlocal,max ${d.maxSurfaceMach.toFixed(2)}`;
  }
  function recordHistory(force=false){if(!force&&solver.iteration-lastHistoryIteration<10)return;lastHistoryIteration=solver.iteration;const d=solver.diagnostics,c=solver.coeffs;history.push({iteration:solver.iteration,time:solver.time,residual:solver.residual,cl:c.cl,cd:c.cd,cm:c.cm,shockX:d.shockDetected?d.shockX:NaN,maxMach:d.maxSurfaceMach});if(history.length>2400)history.splice(0,history.length-2400);window.dispatchEvent(new Event('cfdhistory'));}
  function clearHistory(){history.length=0;lastHistoryIteration=-10;recordHistory(true);}
  function render(){drawFlow();drawCp();drawSection();updateUI()}
  function loop(t){const stepInterval=120/speed;if(!parameterDragging&&running&&t-lastStep>=stepInterval){solver.step();lastStep=t;recordHistory();}if(!parameterDragging&&running&&t-lastFrame>160){render();lastFrame=t}requestAnimationFrame(loop)}
  function updateControlState(){
    const play=$('playButton'),regenerate=$('regenerateButton'),resetButton=$('resetButton'),dot=$('statusDot');
    play.disabled=configurationDirty;regenerate.disabled=!configurationDirty;resetButton.disabled=configurationDirty;
    $('playIcon').textContent=running?'Ⅱ':'▶';$('playLabel').textContent=running?'一時停止':hasStarted?'再開':'計算開始';
    const status=configurationDirty?'格子更新待ち':running?'計算中':hasStarted?'一時停止':'待機中';$('statusText').textContent=status;if($('convStatus'))$('convStatus').textContent=status;
    dot.classList.toggle('dirty',configurationDirty);dot.classList.toggle('paused',!running&&!configurationDirty);
  }
  function setParameterInteraction(active){parameterDragging=!!active;if(!parameterDragging){lastFrame=0;lastStep=performance.now()}}
  function markConfigurationDirty(){configurationDirty=true;running=false;hasStarted=false;updateControlState()}
  function stageGeometry(geometry){stagedGeometry={...geometry};markConfigurationDirty()}
  let flightPending=false,reynoldsPending=false;
  const markFlightPending=()=>{flightPending=true;markConfigurationDirty()},commitFlight=()=>{flightPending=false};
  const markReynoldsPending=()=>{reynoldsPending=true;markConfigurationDirty()},commitReynolds=()=>{reynoldsPending=false};
  // UI値は保留し、格子再生成ボタンを押すまでCFD状態へ適用しない。
  const aoaField=CFDNumericField({slider:$('aoaSlider'),field:$('aoaInput'),min:-10,max:50,step:.5,onChange:markFlightPending,onCommit:commitFlight,onInteraction:setParameterInteraction});
  const machField=CFDNumericField({slider:$('machSlider'),field:$('machInput'),min:.3,max:1.2,step:.01,onChange:markFlightPending,onCommit:commitFlight,onInteraction:setParameterInteraction});
  const reynoldsField=CFDNumericField({slider:$('reynoldsSlider'),field:$('reynoldsInput'),min:1e4,max:1e7,step:1,keyStep:1000,fromSlider:reynoldsFromSlider,toSlider:re=>Math.log10(re),onChange:markReynoldsPending,onCommit:commitReynolds,onInteraction:setParameterInteraction});
  function regenerateGrid(){
    const [nx,ny]=$('gridSelect').value.split('x').map(Number);
    if(nx!==solver.nx||ny!==solver.ny)solver=new CFDSolver(nx,ny);
    solver.geometry={...stagedGeometry};solver.reynolds=reynoldsField.value;solver.frictionModel=$('frictionSelect').value;solver.reset(machField.value,aoaField.value,true);
    configurationDirty=false;running=false;hasStarted=false;flightPending=false;reynoldsPending=false;lastStep=0;lastFrame=0;clearHistory();render();window.dispatchEvent(new Event('cfdgeometrychange'));updateControlState();
  }
  function resetToWaiting(){
    if(configurationDirty)return;running=false;hasStarted=false;solver.reset(solver.mach,solver.aoa,false);lastStep=0;lastFrame=0;clearHistory();render();updateControlState();
  }
  $('frictionSelect').addEventListener('change',markConfigurationDirty);
  $('regenerateButton').addEventListener('click',regenerateGrid);$('resetButton').addEventListener('click',resetToWaiting);
  $('speedSelect').addEventListener('change',e=>speed=+e.target.value);$('gridSelect').addEventListener('change',markConfigurationDirty);
  $('playButton').addEventListener('click',()=>{if(configurationDirty)return;running=!running;hasStarted=true;lastStep=performance.now();updateControlState()});
  document.querySelectorAll('[data-field]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-field]').forEach(q=>q.classList.remove('active'));b.classList.add('active');field=b.dataset.field;drawColorbar();render()}));
  window.cfdApp={stageGeometry,setParameterInteraction,getGeometry:()=>({...solver.geometry}),sectionY:x=>solver.sectionY(x),getHistory:()=>history.slice(),getState:()=>({iteration:solver.iteration,time:solver.time,residual:solver.residual,mach:solver.mach,aoa:solver.aoa,reynolds:solver.reynolds,frictionModel:solver.frictionModel,running,hasStarted,configurationDirty,backend:solver.backend})};
  window.addEventListener('resize',render);
  reynoldsField.set(solver.reynolds);$('frictionSelect').value=solver.frictionModel;
  drawColorbar();render();clearHistory();updateControlState();requestAnimationFrame(loop);
})();
