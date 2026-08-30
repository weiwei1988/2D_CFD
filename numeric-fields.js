/*
 * レンジスライダーと半角数字入力を1つの値へ束ねる小さなヘルパー。
 * 数値入力は change（Enter またはフォーカス外れ）で確定し、全角数字と桁区切りは半角へ正規化する。
 */
(function(global){
  'use strict';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const PUNCTUATION={'．':'.','，':'','、':'','－':'-','−':'-','ー':'-','―':'-','＋':'+','＝':'','　':''};
  function normalise(text){
    return String(text)
      .replace(/[０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0))
      .replace(/[．，、－−ー―＋＝　]/g,ch=>PUNCTUATION[ch])
      .replace(/[\s,]/g,'');
  }
  function decimalsOf(step){const text=String(step),dot=text.indexOf('.');return dot<0?0:text.length-dot-1}

  function bindNumericField(config){
    const {slider,field,min,max,step,onChange}=config;
    const fromSlider=config.fromSlider||(value=>value),toSlider=config.toSlider||(value=>value);
    const keyStep=config.keyStep||step,decimals=config.decimals??decimalsOf(step);
    const quantise=value=>+(Math.round(value/step)*step).toFixed(9);
    let value=clamp(quantise(fromSlider(+slider.value)),min,max);
    const paint=()=>{field.value=value.toFixed(decimals);slider.value=toSlider(value)};
    const commit=(next,notify)=>{
      const settled=clamp(quantise(next),min,max),changed=settled!==value;
      value=settled;paint();
      if(notify&&changed)onChange(value);
    };
    const typed=()=>{const parsed=parseFloat(normalise(field.value));return Number.isFinite(parsed)?parsed:value};
    slider.addEventListener('input',()=>commit(fromSlider(+slider.value),true));
    field.addEventListener('change',()=>commit(typed(),true));
    field.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();field.blur();return}
      const direction=event.key==='ArrowUp'?1:event.key==='ArrowDown'?-1:0;
      if(!direction)return;
      event.preventDefault();
      commit(typed()+direction*keyStep*(event.shiftKey?10:1),true);
    });
    paint();
    return{get value(){return value},set(next){commit(next,false)}};
  }
  global.CFDNumericField=bindNumericField;
  global.CFDNormaliseNumber=normalise;
})(window);
