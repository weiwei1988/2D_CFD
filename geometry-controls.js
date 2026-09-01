(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  // scale は画面の表示単位から solver の無次元量への換算。step は数値入力とスライダーで共通。
  const CONTROLS={
    thickness:{min:8,max:18,step:.1,scale:.01},
    leadingEdge:{min:.6,max:1.6,step:.05,scale:1},
    camber:{min:0,max:6,step:.1,scale:.01},
    camberPosition:{min:25,max:65,step:.5,scale:.01},
    flattening:{min:0,max:2,step:.1,scale:.01},
    lowerBias:{min:0,max:.8,step:.05,scale:.01}
  };
  const presets={
    'supercritical-baseline':{values:{thickness:12,leadingEdge:1,camber:2.2,camberPosition:42,flattening:1,lowerBias:.35},note:'基準スーパクリティカル翼型 · 12%厚のパラメトリック形状'},
    naca0009:{values:{thickness:9,leadingEdge:1,camber:0,camberPosition:40,flattening:0,lowerBias:0},note:'NACA 0009 · 対称9%厚 · 閉じた後縁'},
    naca0012:{values:{thickness:12,leadingEdge:1,camber:0,camberPosition:40,flattening:0,lowerBias:0},note:'NACA 0012 · 対称12%厚 · 閉じた後縁'},
    naca0015:{values:{thickness:15,leadingEdge:1,camber:0,camberPosition:40,flattening:0,lowerBias:0},note:'NACA 0015 · 対称15%厚 · 閉じた後縁'},
    naca2412:{values:{thickness:12,leadingEdge:1,camber:2,camberPosition:40,flattening:0,lowerBias:0},note:'NACA 2412 · 最大キャンバー2% @ 40%c'},
    naca4412:{values:{thickness:12,leadingEdge:1,camber:4,camberPosition:40,flattening:0,lowerBias:0},note:'NACA 4412 · 最大キャンバー4% @ 40%c'},
    sc20412:{values:{thickness:12,leadingEdge:1.1,camber:1.8,camberPosition:40,flattening:1.1,lowerBias:.3},note:'NASA SC(2)-0412相当 · パラメトリック近似'},
    sc20612:{values:{thickness:12,leadingEdge:1.1,camber:2.8,camberPosition:42,flattening:1.3,lowerBias:.4},note:'NASA SC(2)-0612相当 · パラメトリック近似'},
    rae2822:{values:{thickness:12,leadingEdge:1.05,camber:1.8,camberPosition:40,flattening:.8,lowerBias:.32},note:'RAE 2822相当 · パラメトリック近似'}
  };
  const presetSelect=$('airfoilPreset'),presetNote=$('airfoilPresetNote');
  let previewQueued=false,pendingGeometry=null;
  function updatePresetNote(text){presetNote.textContent=text}
  function markCustom(){presetSelect.value='custom';updatePresetNote('カスタム · 選択した形状をスライダーと数値入力で微調整')}
  function readGeometry(){const g={};for(const [name,spec] of Object.entries(CONTROLS))g[name]=fields[name].value*spec.scale;return g}
  function stage(next){const geometry=next||pendingGeometry||readGeometry();if(!window.cfdApp){if(window.cfdReady)window.cfdReady.then(()=>stage(geometry));return}window.cfdApp.stageGeometry(geometry)}
  function drawPreview(){previewQueued=false;if(!pendingGeometry)return;window.dispatchEvent(new CustomEvent('cfdgeometrypreview',{detail:{...pendingGeometry}}));stage(pendingGeometry)}
  function schedulePreview(){pendingGeometry=readGeometry();if(previewQueued)return;previewQueued=true;requestAnimationFrame(drawPreview)}
  function commit(){if(pendingGeometry)stage(pendingGeometry)}
  function selectPreset(key){const preset=presets[key];if(!preset)return;for(const [name,value] of Object.entries(preset.values))fields[name].set(value);updatePresetNote(preset.note);pendingGeometry=readGeometry();window.dispatchEvent(new CustomEvent('cfdgeometrypreview',{detail:{...pendingGeometry}}));stage(pendingGeometry)}

  const fields={};
  for(const [name,spec] of Object.entries(CONTROLS))
    fields[name]=CFDNumericField({slider:$(name+'Slider'),field:$(name+'Input'),min:spec.min,max:spec.max,step:spec.step,onChange:()=>{markCustom();schedulePreview()},onCommit:commit,onInteraction:active=>window.cfdApp?.setParameterInteraction(active)});

  presetSelect.addEventListener('change',()=>{if(presetSelect.value==='custom'){updatePresetNote('カスタム · 現在の形状をスライダーと数値入力で微調整');return}selectPreset(presetSelect.value)});
  $('geometryReset').addEventListener('click',()=>{presetSelect.value='supercritical-baseline';selectPreset('supercritical-baseline')});
  const initialPreset=presets[presetSelect.value]?presetSelect.value:'supercritical-baseline';presetSelect.value=initialPreset;updatePresetNote(presets[initialPreset].note);
})();
