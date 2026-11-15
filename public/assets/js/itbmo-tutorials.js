(()=>{
 'use strict';
 const gallery=document.querySelector('[data-tutorial-gallery]');
 if(!gallery)return;
 const es=gallery.dataset.language==='es';
 const buttons=[...gallery.querySelectorAll('[data-tutorial]')];
 const video=gallery.querySelector('#tg-video'),watch=gallery.querySelector('#tg-watch');
 const previous=gallery.querySelector('#tg-prev'),next=gallery.querySelector('#tg-next');
 const error=gallery.querySelector('#tg-error');
 let selected=0;
 function select(index,updateUrl=true){
  selected=Math.max(0,Math.min(buttons.length-1,index));
  const lesson=buttons[selected];
  video.pause();
  video.removeAttribute('src');
  video.querySelectorAll('track').forEach(track=>track.remove());
  video.load();
  video.controls=false;
  video.poster=lesson.dataset.poster;
  video.setAttribute('aria-label',lesson.dataset.title);
  watch.hidden=false;
  watch.querySelector('small').textContent=lesson.dataset.duration;
  error.hidden=true;
  gallery.querySelector('#tg-step').textContent=`${es?'PASO':'STEP'} ${String(selected+1).padStart(2,'0')} / 05`;
  gallery.querySelector('#tg-title').textContent=lesson.dataset.title;
  gallery.querySelector('#tg-description').textContent=lesson.dataset.description;
  gallery.querySelector('#tg-hint').textContent=lesson.dataset.hint;
  gallery.querySelector('#tg-direct').href=lesson.dataset.src;
  buttons.forEach((button,i)=>{button.classList.toggle('is-active',i===selected);button.setAttribute('aria-current',i===selected?'step':'false');});
  previous.disabled=selected===0;
  next.disabled=selected===buttons.length-1;
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('tutorial',String(selected+1));url.hash='tutoriales';history.replaceState(null,'',url);if(window.matchMedia('(max-width:1000px)').matches)gallery.querySelector('.tg-feature').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});}
 }
 function play(){
  const lesson=buttons[selected];
  error.hidden=true;
  if(!video.getAttribute('src')){
   const track=document.createElement('track');
   track.kind='subtitles';track.srclang=es?'es':'en';track.label=es?'Guía en español':'English guide';track.src=lesson.dataset.captions;
   video.append(track);
   video.src=lesson.dataset.src;
   video.controls=true;
  }
  const promise=video.play();
  if(promise)promise.catch(()=>{watch.hidden=false;});
 }
 buttons.forEach((button,i)=>button.addEventListener('click',()=>select(i)));
 previous.addEventListener('click',()=>select(selected-1));
 next.addEventListener('click',()=>select(selected+1));
 watch.addEventListener('click',play);
 video.addEventListener('playing',()=>{watch.hidden=true;error.hidden=true;});
 video.addEventListener('ended',()=>{watch.hidden=false;});
 video.addEventListener('error',()=>{if(video.getAttribute('src')){error.hidden=false;watch.hidden=false;}});
 gallery.querySelector('#tg-retry').addEventListener('click',()=>{select(selected,false);play();});
 gallery.querySelector('[data-jump-result]').addEventListener('click',()=>select(3));
 const screen=gallery.querySelector('.tg-screen'),screenHome=screen.parentElement;
 const modal=document.createElement('dialog');modal.className='tg-modal';modal.setAttribute('aria-label',es?'Video ampliado':'Enlarged video');
 const close=document.createElement('button');close.type='button';close.className='tg-modal-close';close.textContent=es?'Cerrar ×':'Close ×';close.setAttribute('aria-label',es?'Cerrar video ampliado':'Close enlarged video');
 modal.append(close);gallery.append(modal);
 close.addEventListener('click',()=>modal.close());
 modal.addEventListener('close',()=>screenHome.prepend(screen));
 gallery.querySelector('#tg-fullscreen').addEventListener('click',()=>{modal.append(screen);modal.showModal();});
 window.addEventListener('pagehide',()=>video.pause());
 document.addEventListener('visibilitychange',()=>{if(document.hidden)video.pause();});
 const initial=Number(new URLSearchParams(location.search).get('tutorial'));
 select(Number.isInteger(initial)&&initial>=1&&initial<=5?initial-1:0,false);
})();
