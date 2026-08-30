/*
 * 2-D compressible Navier–Stokes demonstrator.
 * Cell-centred finite volume on a body-fitted O-grid, HLL shock-capturing
 * flux, explicit viscosity and a slip-wall pressure boundary condition.
 */
(function(global){
  'use strict';
  const G=1.4,PR=.72,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const DEFAULT_GEOMETRY={thickness:.12,leadingEdge:1,camber:.022,camberPosition:.42,flattening:.010,lowerBias:.0035};
  const DEFAULT_REYNOLDS=5e4,REYNOLDS_RANGE={min:1e4,max:1e7};
  // 摩擦抗力は平板近似の後処理項。圧力抗力へ加算するだけで流れ場そのものには影響しない。
  const FRICTION_MODELS={
    turbulent:{label:'平板乱流 0.074/Re^0.2',cf:re=>.074/Math.pow(re,.2)},
    laminar:{label:'平板層流 1.328/√Re',cf:re=>1.328/Math.sqrt(re)},
    none:{label:'摩擦なし（圧力抗力のみ）',cf:()=>0}
  };
  const WASM_CELL_FIELDS=['rho','mx','my','E','nr','nmx','nmy','nE','vorticity','machField','schlieren','cellX','cellY','cellArea','uField','vField','pField','aField','xiNx','xiNy','xiLen','etaNx','etaNy','etaLen'];
  const WASM_WALL_FIELDS=['wallNx','wallNy','wallLen','wallX','wallY'];
  let wasmModule=null,wasmFailed=false;
  function smoothstep(a,b,x){const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)}

  function sectionY(x,g=DEFAULT_GEOMETRY){
    x=clamp(x,0,1);
    const t=clamp(g.thickness,.06,.22),le=Math.sqrt(clamp(g.leadingEdge,.35,2.2));
    const leadDelta=.2969*(le-1);
    const shape=.2969*le*Math.sqrt(Math.max(x,1e-7))-(.126+leadDelta)*x-.3516*x*x+.2843*x*x*x-.1036*x*x*x*x;
    const yt=5*t*Math.max(shape,0),m=clamp(g.camber,0,.08),p=clamp(g.camberPosition,.2,.75);
    const yc=x<p?m/(p*p)*(2*p*x-x*x):m/((1-p)*(1-p))*((1-2*p)+2*p*x-x*x);
    const flat=clamp(g.flattening,0,.03)*smoothstep(.28,.82,x)*(1-x);
    const lowerBias=clamp(g.lowerBias??.0035,0,.008)*(t/.12)*Math.sin(Math.PI*x)*smoothstep(.15,.65,x);
    return{upper:yc+yt-flat,lower:yc-yt-lowerBias};
  }

  class CFDSolver{
    static async initialize(){
      if(wasmModule)return true;if(wasmFailed)return false;
      if(typeof global.createCFDCore!=='function'){wasmFailed=true;return false}
      try{wasmModule=await global.createCFDCore({locateFile:path=>path==='cfd-core.wasm'?path+'?v=aero-20260830-2':path});return true}catch(error){wasmFailed=true;console.warn('C++/WebAssembly solver unavailable; JavaScript fallback is active.',error);return false}
    }
    constructor(nx=128,ny=64){
      this.nx=Math.max(96,Math.round(nx));this.ny=Math.max(48,Math.round(ny));this.n=this.nx*this.ny;
      this.xmin=-1.05;this.xmax=2.05;this.ymin=-.82;this.ymax=.82;this.cfl=.38;this.backend=wasmModule?'cpp-wasm':'javascript';
      if(wasmModule){
        if(!wasmModule._cfd_create(this.nx,this.ny))throw new Error('C++ solver allocation failed');
        for(const name of WASM_CELL_FIELDS){const pointer=wasmModule['_cfd_ptr_'+name]();this[name]=new Float32Array(wasmModule.HEAPF32.buffer,pointer,this.n)}
        for(const name of WASM_WALL_FIELDS){const pointer=wasmModule['_cfd_ptr_'+name]();this[name]=new Float32Array(wasmModule.HEAPF32.buffer,pointer,this.nx)}
      }else{
        for(const name of WASM_CELL_FIELDS)this[name]=new Float32Array(this.n);
        for(const name of WASM_WALL_FIELDS)this[name]=new Float32Array(this.nx);
      }
      const nn=this.nx*(this.ny+1);this.nodeX=new Float32Array(nn);this.nodeY=new Float32Array(nn);this.surfaceX=new Float32Array(this.nx);this.surfaceTheta=new Float32Array(this.nx);
      this.reynolds=DEFAULT_REYNOLDS;this.frictionModel='turbulent';this.geometry={...DEFAULT_GEOMETRY};this.mach=.9;this.aoa=2;this.reset(this.mach,this.aoa);
    }
    idx(i,j){i=(i%this.nx+this.nx)%this.nx;return i+j*this.nx}
    nodeIdx(i,j){i=(i%this.nx+this.nx)%this.nx;return i+j*this.nx}
    sectionY(x){return sectionY(x,this.geometry)}
    setGeometry(patch){this.geometry={...this.geometry,...patch};this.reset(this.mach,this.aoa)}
    sectionToWorld(x,y){const a=-this.aoa*Math.PI/180,px=x-.25;return{x:.25+px*Math.cos(a)-y*Math.sin(a),y:px*Math.sin(a)+y*Math.cos(a)}}
    setReynolds(value){const re=+value;if(!Number.isFinite(re))return;this.reynolds=clamp(re,REYNOLDS_RANGE.min,REYNOLDS_RANGE.max);this.reset(this.mach,this.aoa)}
    setFrictionModel(key){if(!FRICTION_MODELS[key])return;this.frictionModel=key;this.sampleSurface()}
    skinFriction(){return FRICTION_MODELS[this.frictionModel].cf(this.reynolds)}

    buildGrid(){
      const ni=this.nx,nj=this.ny,dense=Math.max(4096,ni*16),px=new Float64Array(dense+1),py=new Float64Array(dense+1),th=new Float64Array(dense+1),arc=new Float64Array(dense+1);
      for(let m=0;m<=dense;m++){
        const theta=2*Math.PI*m/dense,x=.5*(1+Math.cos(theta)),s=this.sectionY(x),te=.0015*Math.pow(x,14),y=theta<=Math.PI?s.upper+te:s.lower-te;
        px[m]=x;py[m]=y;th[m]=theta;if(m)arc[m]=arc[m-1]+Math.hypot(px[m]-px[m-1],py[m]-py[m-1]);
      }
      const perimeter=arc[dense];let cursor=1;
      for(let i=0;i<ni;i++){
        // Preserve the leading-edge concentration while adding a second minimum
        // in spacing at the periodic trailing-edge/wake seam.
        const uArc=i/ni,leadingBias=.25,edgeBias=.45,target=perimeter*(uArc+leadingBias*Math.sin(2*Math.PI*uArc)/(2*Math.PI)-edgeBias*Math.sin(4*Math.PI*uArc)/(4*Math.PI));while(cursor<dense&&arc[cursor]<target)cursor++;const a=Math.max(0,cursor-1),b=Math.min(dense,cursor),z=(target-arc[a])/Math.max(arc[b]-arc[a],1e-12);
        this.surfaceX[i]=px[a]+z*(px[b]-px[a]);this.surfaceTheta[i]=th[a]+z*(th[b]-th[a]);
        const sy=py[a]+z*(py[b]-py[a]),inner=this.sectionToWorld(this.surfaceX[i],sy),outerTheta=this.surfaceTheta[i],outer=this.sectionToWorld(.5+1.55*Math.cos(outerTheta),1.0*Math.sin(outerTheta));
        for(let j=0;j<=nj;j++){
          const eta=j/nj,beta=.85,f=Math.expm1(beta*eta)/Math.expm1(beta),k=this.nodeIdx(i,j);
          this.nodeX[k]=inner.x+f*(outer.x-inner.x);this.nodeY[k]=inner.y+f*(outer.y-inner.y);
        }
      }
      let gx0=Infinity,gx1=-Infinity,gy0=Infinity,gy1=-Infinity;for(let k=0;k<this.nodeX.length;k++){gx0=Math.min(gx0,this.nodeX[k]);gx1=Math.max(gx1,this.nodeX[k]);gy0=Math.min(gy0,this.nodeY[k]);gy1=Math.max(gy1,this.nodeY[k])}const padx=.018*(gx1-gx0),pady=.025*(gy1-gy0);this.xmin=gx0-padx;this.xmax=gx1+padx;this.ymin=gy0-pady;this.ymax=gy1+pady;
      this.minCellScale=Infinity;
      for(let j=0;j<nj;j++)for(let i=0;i<ni;i++){
        const ip=(i+1)%ni,k=this.idx(i,j),a=this.nodeIdx(i,j),b=this.nodeIdx(ip,j),c=this.nodeIdx(ip,j+1),d=this.nodeIdx(i,j+1),xs=[this.nodeX[a],this.nodeX[b],this.nodeX[c],this.nodeX[d]],ys=[this.nodeY[a],this.nodeY[b],this.nodeY[c],this.nodeY[d]];
        this.cellX[k]=.25*(xs[0]+xs[1]+xs[2]+xs[3]);this.cellY[k]=.25*(ys[0]+ys[1]+ys[2]+ys[3]);
        let twice=0,per=0;for(let q=0;q<4;q++){const r=(q+1)%4;twice+=xs[q]*ys[r]-ys[q]*xs[r];per+=Math.hypot(xs[r]-xs[q],ys[r]-ys[q])}
        const area=Math.max(Math.abs(twice)*.5,1e-8),scale=Math.max(2*area/Math.max(per,1e-8),1e-5);this.cellArea[k]=area;this.minCellScale=Math.min(this.minCellScale,scale);
      }
      for(let j=0;j<nj;j++)for(let i=0;i<ni;i++){const k=this.idx(i,j),L=this.idx(i-1,j),a=this.nodeIdx(i,j),b=this.nodeIdx(i,j+1),ex=this.nodeX[b]-this.nodeX[a],ey=this.nodeY[b]-this.nodeY[a],len=Math.max(Math.hypot(ex,ey),1e-10),dcx=this.cellX[k]-this.cellX[L],dcy=this.cellY[k]-this.cellY[L];let nx=-ey/len,ny=ex/len;if(nx*dcx+ny*dcy<0){nx=-nx;ny=-ny}this.xiNx[k]=nx;this.xiNy[k]=ny;this.xiLen[k]=len}
      for(let j=1;j<nj;j++)for(let i=0;i<ni;i++){const k=this.idx(i,j),B=k-ni,ip=(i+1)%ni,a=this.nodeIdx(i,j),b=this.nodeIdx(ip,j),ex=this.nodeX[b]-this.nodeX[a],ey=this.nodeY[b]-this.nodeY[a],len=Math.max(Math.hypot(ex,ey),1e-10),dcx=this.cellX[k]-this.cellX[B],dcy=this.cellY[k]-this.cellY[B];let nx=-ey/len,ny=ex/len;if(nx*dcx+ny*dcy<0){nx=-nx;ny=-ny}this.etaNx[k]=nx;this.etaNy[k]=ny;this.etaLen[k]=len}
      for(let i=0;i<ni;i++){const ip=(i+1)%ni,a=this.nodeIdx(i,0),b=this.nodeIdx(ip,0),ex=this.nodeX[b]-this.nodeX[a],ey=this.nodeY[b]-this.nodeY[a],len=Math.max(Math.hypot(ex,ey),1e-10),mx=.5*(this.nodeX[a]+this.nodeX[b]),my=.5*(this.nodeY[a]+this.nodeY[b]),k=this.idx(i,0);let nx=-ey/len,ny=ex/len;if(nx*(mx-this.cellX[k])+ny*(my-this.cellY[k])<0){nx=-nx;ny=-ny}this.wallNx[i]=nx;this.wallNy[i]=ny;this.wallLen[i]=len;this.wallX[i]=mx;this.wallY[i]=my}
    }

    reset(mach,aoa){
      this.mach=+mach;this.aoa=+aoa;this.buildGrid();const p=1/G,u=this.mach,e=p/(G-1)+.5*u*u;
      if(this.backend==='cpp-wasm')wasmModule._cfd_reset(this.mach,this.reynolds,this.cfl,this.minCellScale);else for(let k=0;k<this.n;k++){this.rho[k]=1;this.mx[k]=u;this.my[k]=0;this.E[k]=e}
      this.time=0;this.iteration=0;this.residual=0;this.coeffs={cl:0,cd:0,cdPressure:0,cdFriction:this.skinFriction(),cm:0,cp:NaN};
      this.diagnostics={maxSurfaceMach:this.mach,shockDetected:false,shockX:NaN,shockStrength:0,cpRoughnessRaw:0,cpRoughnessFiltered:0};
      this.cp={x:[],upper:[],lower:[],rawUpper:[],rawLower:[]};this.sampleSurface();
    }
    primitive(k){const r=Math.max(this.rho[k],.12),u=this.mx[k]/r,v=this.my[k]/r,p=Math.max((G-1)*(this.E[k]-.5*r*(u*u+v*v)),.035);return[r,u,v,p,Math.sqrt(G*p/r)]}
    addInternalFace(L,R,nx,ny,len,dt){
      const rL=this.rho[L],rR=this.rho[R],uL=this.uField[L],vL=this.vField[L],uR=this.uField[R],vR=this.vField[R],pL=this.pField[L],pR=this.pField[R],eL=this.E[L],eR=this.E[R],unL=uL*nx+vL*ny,unR=uR*nx+vR*ny,sLw=Math.min(unL-this.aField[L],unR-this.aField[R]),sRw=Math.max(unL+this.aField[L],unR+this.aField[R]);
      let f0,f1,f2,f3;if(sLw>=0){f0=rL*unL;f1=this.mx[L]*unL+pL*nx;f2=this.my[L]*unL+pL*ny;f3=(eL+pL)*unL}else if(sRw<=0){f0=rR*unR;f1=this.mx[R]*unR+pR*nx;f2=this.my[R]*unR+pR*ny;f3=(eR+pR)*unR}else{const z=1/Math.max(sRw-sLw,1e-9),c=sLw*sRw;f0=(sRw*rL*unL-sLw*rR*unR+c*(rR-rL))*z;f1=(sRw*(this.mx[L]*unL+pL*nx)-sLw*(this.mx[R]*unR+pR*nx)+c*(this.mx[R]-this.mx[L]))*z;f2=(sRw*(this.my[L]*unL+pL*ny)-sLw*(this.my[R]*unR+pR*ny)+c*(this.my[R]-this.my[L]))*z;f3=(sRw*(eL+pL)*unL-sLw*(eR+pR)*unR+c*(eR-eL))*z}
      const sL=dt*len/this.cellArea[L],sR=dt*len/this.cellArea[R];this.nr[L]-=sL*f0;this.nmx[L]-=sL*f1;this.nmy[L]-=sL*f2;this.nE[L]-=sL*f3;this.nr[R]+=sR*f0;this.nmx[R]+=sR*f1;this.nmy[R]+=sR*f2;this.nE[R]+=sR*f3;
    }
    wallGeometry(i){return{nx:this.wallNx[i],ny:this.wallNy[i],len:this.wallLen[i],mx:this.wallX[i],my:this.wallY[i]}}
    addWallFace(i,dt){const k=this.idx(i,0),g=this.wallGeometry(i),p=this.pField[k],s=dt*g.len/this.cellArea[k];this.nmx[k]-=s*p*g.nx;this.nmy[k]-=s*p*g.ny}

    step(){
      if(this.backend==='cpp-wasm'){const dt=wasmModule._cfd_step();this.time=wasmModule._cfd_time();this.iteration=wasmModule._cfd_iteration();this.residual=wasmModule._cfd_residual();if(this.iteration%5===0)this.sampleSurface();return dt}
      let wave=1;for(let k=0;k<this.n;k++){const r=Math.max(this.rho[k],.12),u=this.mx[k]/r,v=this.my[k]/r,p=Math.max((G-1)*(this.E[k]-.5*r*(u*u+v*v)),.035),a=Math.sqrt(G*p/r);this.uField[k]=u;this.vField[k]=v;this.pField[k]=p;this.aField[k]=a;wave=Math.max(wave,Math.hypot(u,v)+a)}const dt=this.cfl*this.minCellScale/wave;
      this.nr.set(this.rho);this.nmx.set(this.mx);this.nmy.set(this.my);this.nE.set(this.E);
      for(let j=0;j<this.ny;j++)for(let i=0;i<this.nx;i++){const R=i+j*this.nx,L=(i?i-1:this.nx-1)+j*this.nx;this.addInternalFace(L,R,this.xiNx[R],this.xiNy[R],this.xiLen[R],dt)}
      for(let j=1;j<this.ny;j++)for(let i=0;i<this.nx;i++){const T=i+j*this.nx,B=T-this.nx;this.addInternalFace(B,T,this.etaNx[T],this.etaNy[T],this.etaLen[T],dt)}
      for(let i=0;i<this.nx;i++)this.addWallFace(i,dt);
      const mu=Math.max(this.mach,.3)/this.reynolds;
      for(let j=0;j<this.ny-2;j++)for(let i=0;i<this.nx;i++){
        const k=this.idx(i,j),ids=[this.idx(i-1,j),this.idx(i+1,j),this.idx(i,Math.max(0,j-1)),this.idx(i,j+1)],u=this.uField[k],v=this.vField[k],T=this.pField[k]/Math.max(this.rho[k],.12);let lu=0,lv=0,lT=0;
        for(const n of ids){const d2=Math.max((this.cellX[n]-this.cellX[k])**2+(this.cellY[n]-this.cellY[k])**2,1e-7),w=.5/d2;lu+=w*(this.uField[n]-u);lv+=w*(this.vField[n]-v);lT+=w*(this.pField[n]/Math.max(this.rho[n],.12)-T)}this.nmx[k]+=dt*mu*lu;this.nmy[k]+=dt*mu*lv;this.nE[k]+=dt*(mu/PR*lT+mu*(u*lu+v*lv));
      }
      const pi=1/G,ui=this.mach,ei=pi/(G-1)+.5*ui*ui;let change=0,count=0;
      for(let j=0;j<this.ny;j++)for(let i=0;i<this.nx;i++){const k=this.idx(i,j);if(j>=this.ny-2){this.nr[k]=1;this.nmx[k]=ui;this.nmy[k]=0;this.nE[k]=ei;continue}this.nr[k]=clamp(this.nr[k],.15,4);let u=this.nmx[k]/this.nr[k],v=this.nmy[k]/this.nr[k],sp=Math.hypot(u,v);if(sp>3.5){const z=3.5/sp;this.nmx[k]*=z;this.nmy[k]*=z;u*=z;v*=z}const p=(G-1)*(this.nE[k]-.5*this.nr[k]*(u*u+v*v));if(p<.035)this.nE[k]=.035/(G-1)+.5*this.nr[k]*(u*u+v*v);change+=Math.abs(this.nmx[k]-this.mx[k])+Math.abs(this.nmy[k]-this.my[k]);count++}
      [this.rho,this.nr]=[this.nr,this.rho];[this.mx,this.nmx]=[this.nmx,this.mx];[this.my,this.nmy]=[this.nmy,this.my];[this.E,this.nE]=[this.nE,this.E];this.time+=dt;this.iteration++;this.residual=change/Math.max(count,1);if(this.iteration%5===0)this.sampleSurface();return dt;
    }

    wallPressure(i){
      const k0=this.idx(i,0),k1=this.idx(i,1),p0=this.primitive(k0)[3],p1=this.primitive(k1)[3],g=this.wallGeometry(i),d0=Math.hypot(this.cellX[k0]-g.mx,this.cellY[k0]-g.my),d1=Math.hypot(this.cellX[k1]-g.mx,this.cellY[k1]-g.my),p=p0+(p0-p1)*d0/Math.max(d1-d0,1e-6);return clamp(p,.035,4);
    }
    filterCp(values){let a=values.slice();for(let pass=0;pass<1;pass++){const b=a.slice();for(let i=1;i<a.length-1;i++){const curvature=Math.abs(a[i+1]-2*a[i]+a[i-1]);b[i]=curvature>.22?a[i]:.16*a[i-1]+.68*a[i]+.16*a[i+1]}a=b}return a}
    cpRoughness(a,shockIndex){let sum=0,n=0;for(let i=1;i<a.length-1;i++){if(Math.abs(i-shockIndex)<=3)continue;const d=a[i+1]-2*a[i]+a[i-1];sum+=d*d;n++}return Math.sqrt(sum/Math.max(n,1))}
    sampleSurface(){
      // 壁面法線 g.n は流体セルから翼内向き。翼にはたらく圧力合力は +p·n·len で得る。
      // モーメントは空力慣例に合わせて頭上げを正とするため、z軸まわり反時計回り成分の符号を反転する。
      const pi=1/G,qi=.5*this.mach*this.mach,upper=[],lower=[];let fx=0,fy=0,mo=0;
      for(let i=0;i<this.nx;i++){
        const ip=(i+1)%this.nx,g=this.wallGeometry(i),p=this.wallPressure(i),x=.5*(this.surfaceX[i]+this.surfaceX[ip]),theta=.5*(this.surfaceTheta[i]+(ip===0?2*Math.PI:this.surfaceTheta[ip])),q=this.primitive(this.idx(i,0)),M=Math.hypot(q[1],q[2])/q[4],cp=clamp((p-pi)/Math.max(qi,.045),-6,4),item={x,cp,p,M};
        (theta<=Math.PI?upper:lower).push(item);const dfx=p*g.nx*g.len,dfy=p*g.ny*g.len;fx+=dfx;fy+=dfy;mo+=g.my*dfx-(g.mx-.25)*dfy;
      }
      upper.sort((a,b)=>a.x-b.x);lower.sort((a,b)=>a.x-b.x);const N=Math.min(128,Math.max(48,Math.round(this.nx/2))),xs=Array.from({length:N},(_,i)=>.004+.992*i/(N-1)),interpolate=(list,x,key)=>{let hi=1;while(hi<list.length-1&&list[hi].x<x)hi++;const a=list[Math.max(0,hi-1)],b=list[hi],z=clamp((x-a.x)/Math.max(b.x-a.x,1e-8),0,1);return a[key]+z*(b[key]-a[key])},surfaceUp=xs.map(x=>({x,cp:interpolate(upper,x,'cp'),p:interpolate(upper,x,'p'),M:interpolate(upper,x,'M')})),surfaceLo=xs.map(x=>({x,cp:interpolate(lower,x,'cp'),p:interpolate(lower,x,'p'),M:interpolate(lower,x,'M')})),rawUp=surfaceUp.map(d=>d.cp),rawLo=surfaceLo.map(d=>d.cp),up=this.filterCp(rawUp),lo=this.filterCp(rawLo),iq=1/Math.max(qi,.045),skin=this.skinFriction(),cl=clamp(fy*iq,-4,6),cdp=clamp(fx*iq,-1,4),cm=clamp(mo*iq,-2,2),z=this.iteration<10?1:.22;
      this.coeffs.cl=this.coeffs.cl*(1-z)+cl*z;this.coeffs.cdPressure=this.coeffs.cdPressure*(1-z)+cdp*z;this.coeffs.cm=this.coeffs.cm*(1-z)+cm*z;
      // 摩擦抗力は緩和せず即時反映し、圧力中心は空力慣例 x_cp/c = 0.25 − Cm/Cl で求める。
      this.coeffs.cdFriction=skin;this.coeffs.cd=clamp(Math.max(this.coeffs.cdPressure,0)+skin,0,4);this.coeffs.cp=Math.abs(this.coeffs.cl)>.05?.25-this.coeffs.cm/this.coeffs.cl:NaN;
      let maxM=0,best={strength:0,x:NaN,index:-10};for(const d of surfaceUp)maxM=Math.max(maxM,d.M);for(let i=2;i<surfaceUp.length-2;i++){const dp=surfaceUp[i+2].p-surfaceUp[i-2].p,dm=surfaceUp[i-2].M-surfaceUp[i+2].M;if(surfaceUp[i-2].M>.98&&dp>best.strength&&dm>.06)best={strength:dp,x:surfaceUp[i].x,index:i}} 
      this.diagnostics={maxSurfaceMach:maxM,shockDetected:maxM>1&&best.strength>.009,shockX:best.x,shockStrength:best.strength,cpRoughnessRaw:this.cpRoughness(rawUp,best.index),cpRoughnessFiltered:this.cpRoughness(up,best.index)};
      this.cp={x:xs,upper:up,lower:lo,rawUpper:rawUp,rawLower:rawLo};
    }

    logicalGradient(field,k,i,j){
      const im=this.idx(i-1,j),ip=this.idx(i+1,j),jm=this.idx(i,Math.max(0,j-1)),jp=this.idx(i,Math.min(this.ny-1,j+1)),dEta=j===0?1:j===this.ny-1?1:2;
      const fx=.5*(field[ip]-field[im]),fe=(field[jp]-field[jm])/dEta,xx=.5*(this.cellX[ip]-this.cellX[im]),xe=(this.cellX[jp]-this.cellX[jm])/dEta,yx=.5*(this.cellY[ip]-this.cellY[im]),ye=(this.cellY[jp]-this.cellY[jm])/dEta,J=xx*ye-xe*yx;
      if(Math.abs(J)<1e-10)return[0,0];return[(fx*ye-fe*yx)/J,(-fx*xe+fe*xx)/J];
    }
    updateDerivedFields(){
      if(this.backend==='cpp-wasm'){wasmModule._cfd_update_derived();return}
      const u=new Float32Array(this.n),v=new Float32Array(this.n),r=this.rho;for(let k=0;k<this.n;k++){const q=this.primitive(k);u[k]=q[1];v[k]=q[2];this.machField[k]=Math.hypot(q[1],q[2])/q[4]}
      for(let j=0;j<this.ny;j++)for(let i=0;i<this.nx;i++){const k=this.idx(i,j),gu=this.logicalGradient(u,k,i,j),gv=this.logicalGradient(v,k,i,j),gr=this.logicalGradient(r,k,i,j);this.vorticity[k]=gv[0]-gu[1];this.schlieren[k]=Math.log1p(6*Math.hypot(gr[0],gr[1]))}
    }
  }
  global.CFDSolver=CFDSolver;global.CFDSectionY=sectionY;global.CFDDefaultGeometry={...DEFAULT_GEOMETRY};global.CFDFrictionModels=FRICTION_MODELS;global.CFDReynoldsRange={...REYNOLDS_RANGE};global.CFDDefaultReynolds=DEFAULT_REYNOLDS;
})(window);
