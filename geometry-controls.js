(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const controls={
    thickness:{input:$('thicknessSlider'),output:$('thicknessOutput'),scale:.01,format:v=>`${v.toFixed(0)}%`},
    leadingEdge:{input:$('leadingEdgeSlider'),output:$('leadingEdgeOutput'),scale:1,format:v=>`${v.toFixed(1)}×`},
    camber:{input:$('camberSlider'),output:$('camberOutput'),scale:.01,format:v=>`${v.toFixed(1)}%`},
    camberPosition:{input:$('camberPositionSlider'),output:$('camberPositionOutput'),scale:.01,format:v=>`${v.toFixed(0)}%c`},
    flattening:{input:$('flatteningSlider'),output:$('flatteningOutput'),scale:.01,format:v=>`${v.toFixed(1)}%`}
  };
  const presets={
    'supercritical-baseline':{values:{thickness:12,leadingEdge:1,camber:2.2,camberPosition:42,flattening:1},lowerBias:.0035,note:'基準スーパクリティカル翼型 · 12%厚のパラメトリック形状'},
    naca0009:{values:{thickness:9,leadingEdge:1,camber:0,camberPosition:40,flattening:0},lowerBias:0,note:'NACA 0009 · 対称9%厚 · 閉じた後縁'},
    naca0012:{values:{thickness:12,leadingEdge:1,camber:0,camberPosition:40,flattening:0},lowerBias:0,note:'NACA 0012 · 対称12%厚 · 閉じた後縁'},
    naca0015:{values:{thickness:15,leadingEdge:1,camber:0,camberPosition:40,flattening:0},lowerBias:0,note:'NACA 0015 · 対称15%厚 · 閉じた後縁'},
    naca2412:{values:{thickness:12,leadingEdge:1,camber:2,camberPosition:40,flattening:0},lowerBias:0,note:'NACA 2412 · 最大キャンバー2% @ 40%c'},
    naca4412:{values:{thickness:12,leadingEdge:1,camber:4,camberPosition:40,flattening:0},lowerBias:0,note:'NACA 4412 · 最大キャンバー4% @ 40%c'},
    sc20412:{values:{thickness:12,leadingEdge:1.1,camber:1.8,camberPosition:40,flattening:1.1},lowerBias:.003,note:'NASA SC(2)-0412相当 · パラメトリック近似'},
    sc20612:{values:{thickness:12,leadingEdge:1.1,camber:2.8,camberPosition:42,flattening:1.3},lowerBias:.004,note:'NASA SC(2)-0612相当 · パラメトリック近似'},
    rae2822:{values:{thickness:12,leadingEdge:1.05,camber:1.8,camberPosition:40,flattening:.8},lowerBias:.0032,note:'RAE 2822相当 · パラメトリック近似'}
  };
  const presetSelect=$('airfoilPreset'),presetNote=$('airfoilPresetNote');
  let queued=false,activeExtras={lowerBias:.0035};
  function readGeometry(){const g={};for(const [name,c] of Object.entries(controls))g[name]=+c.input.value*c.scale;return g}
  function updateLabels(){for(const c of Object.values(controls))c.output.textContent=c.format(+c.input.value)}
  function updatePresetNote(text){presetNote.textContent=text}
  function apply(){queued=false;if(!window.cfdApp){if(window.cfdReady)window.cfdReady.then(apply);return}updateLabels();window.cfdApp.setGeometry({...readGeometry(),...activeExtras});window.dispatchEvent(new Event('cfdgeometrychange'))}
  function schedule(){if(queued)return;queued=true;requestAnimationFrame(apply)}
  function selectPreset(key){const preset=presets[key];if(!preset)return;for(const [name,value] of Object.entries(preset.values))controls[name].input.value=value;activeExtras={lowerBias:preset.lowerBias};updatePresetNote(preset.note);apply()}
  for(const c of Object.values(controls))c.input.addEventListener('input',()=>{presetSelect.value='custom';updatePresetNote('カスタム · 選択した形状をスライダーで微調整');schedule()});
  presetSelect.addEventListener('change',()=>{if(presetSelect.value==='custom'){updatePresetNote('カスタム · 現在の形状をスライダーで微調整');return}selectPreset(presetSelect.value)});
  $('geometryReset').addEventListener('click',()=>{presetSelect.value='supercritical-baseline';selectPreset('supercritical-baseline')});
  const initialPreset=presets[presetSelect.value]?presetSelect.value:'supercritical-baseline';presetSelect.value=initialPreset;updateLabels();updatePresetNote(presets[initialPreset].note);
})();
