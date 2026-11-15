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
  resetDock();
  end.hidden=true;
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
  end.hidden=true;  revealPlayer();
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
 video.addEventListener('playing',()=>{watch.hidden=true;end.hidden=true;error.hidden=true;});
 video.addEventListener('ended',()=>{watch.hidden=true;updateEnd();end.hidden=false;});
 video.addEventListener('error',()=>{if(video.getAttribute('src')){error.hidden=false;watch.hidden=false;}});
 gallery.querySelector('#tg-retry').addEventListener('click',()=>{select(selected,false);play();});
 gallery.querySelector('[data-jump-result]').addEventListener('click',()=>select(3));
 const screen=gallery.querySelector('.tg-screen');
 const slot=document.createElement('div');slot.className='tg-video-slot';screen.before(slot);slot.append(screen);
 const modal=document.createElement('dialog');modal.className='tg-modal';modal.setAttribute('aria-label',es?'Video ampliado':'Enlarged video');
 const close=document.createElement('button');close.type='button';close.className='tg-modal-close';close.textContent=es?'Cerrar ×':'Close ×';close.setAttribute('aria-label',es?'Cerrar video ampliado':'Close enlarged video');
 modal.append(close);gallery.append(modal);
 const tools=document.createElement('div');tools.className='tg-dock-tools';
 const back=document.createElement('button'),dismiss=document.createElement('button');back.type=dismiss.type='button';
 back.textContent=es?'Volver al video':'Back to video';dismiss.textContent='×';dismiss.setAttribute('aria-label',es?'Cerrar reproductor flotante':'Close floating player');
 tools.append(back,dismiss);screen.append(tools);
 const end=document.createElement('div');end.className='tg-end';end.hidden=true;
 const endInner=document.createElement('div');endInner.className='tg-end-inner';
 const endHeading=document.createElement('p');endHeading.className='tg-end-heading';endHeading.setAttribute('aria-live','polite');
 const endActions=document.createElement('div');endActions.className='tg-end-actions';endActions.setAttribute('role','group');endActions.setAttribute('aria-label',es?'Opciones al terminar el tutorial':'Options after the tutorial');
 function endButton(label){const button=document.createElement('button');button.type='button';const kicker=document.createElement('span');kicker.className='tg-end-kicker';kicker.textContent=label;const title=document.createElement('strong'),description=document.createElement('small');button.append(kicker,title,description);endActions.append(button);return {button,title,description};}
 const endPrevious=endButton(es?'Anterior':'Previous'),endReplay=endButton(es?'Ver de nuevo':'Watch again'),endNext=endButton(es?'Siguiente':'Next');
 endReplay.button.className='is-replay';endInner.append(endHeading,endActions);end.append(endInner);screen.append(end);
 function lessonSummary(index,control,missingTitle,missingDescription){const lesson=buttons[index];control.button.disabled=!lesson;control.title.textContent=lesson?lesson.querySelector('.tg-lesson-copy strong').textContent:missingTitle;control.description.textContent=lesson?lesson.dataset.description:missingDescription;}
 function updateEnd(){
  endHeading.textContent=es?'Tutorial completado. ¿Cómo quieres continuar?':'Tutorial complete. What would you like to do next?';
  lessonSummary(selected-1,endPrevious,es?'Primer tutorial':'First tutorial',es?'Estás al inicio del recorrido.':'You are at the start of the walkthrough.');
  lessonSummary(selected+1,endNext,es?'Recorrido completo':'Walkthrough complete',es?'Este es el último tutorial.':'This is the last tutorial.');
  endReplay.title.textContent=buttons[selected].querySelector('.tg-lesson-copy strong').textContent;endReplay.description.textContent=es?'Repetir este tutorial desde el inicio.':'Replay this tutorial from the beginning.';
 }
 endPrevious.button.addEventListener('click',()=>{if(selected>0){select(selected-1);play();}});
 endNext.button.addEventListener('click',()=>{if(selected<buttons.length-1){select(selected+1);play();}});
 endReplay.button.addEventListener('click',()=>{video.currentTime=0;play();});

 let hasPlayed=false,dockDismissed=false,visibleRatio=1;
 const reduced=()=>window.matchMedia('(prefers-reduced-motion:reduce)').matches;
 function headerOffset(){const header=document.querySelector('header');return Math.max(12,Math.ceil(header?header.getBoundingClientRect().bottom:68)+12);}
 function syncDock(){
  const docked=hasPlayed&&!dockDismissed&&!modal.open&&!document.fullscreenElement&&visibleRatio<.55;
  screen.classList.toggle('is-docked',docked);
 }
 function resetDock(){hasPlayed=false;dockDismissed=false;screen.classList.remove('is-docked');}
 function revealPlayer(){dockDismissed=false;if(!modal.open)slot.scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});}
 let observer;
 function watchVisibility(){
  const offset=headerOffset();gallery.style.setProperty('--tg-header-offset',offset+'px');
  gallery.style.setProperty('--tg-dock-max-width',Math.min(480,Math.max(100,(window.innerHeight-offset-62)*16/9))+'px');
  if(observer)observer.disconnect();
  observer=new IntersectionObserver(entries=>{visibleRatio=entries[0].intersectionRatio;syncDock();},{rootMargin:`-${offset}px 0px 0px 0px`,threshold:[0,.25,.55,1]});observer.observe(slot);
 }
 watchVisibility();window.addEventListener('resize',watchVisibility);
 video.addEventListener('playing',()=>{hasPlayed=true;dockDismissed=false;syncDock();});
 video.addEventListener('ended',syncDock);document.addEventListener('fullscreenchange',syncDock);
 back.addEventListener('click',revealPlayer);
 dismiss.addEventListener('click',()=>{dockDismissed=true;video.pause();syncDock();});
 close.addEventListener('click',()=>modal.close());
 modal.addEventListener('close',()=>{slot.append(screen);syncDock();});
 gallery.querySelector('#tg-fullscreen').addEventListener('click',()=>{screen.classList.remove('is-docked');modal.append(screen);modal.showModal();});
 window.addEventListener('pagehide',()=>video.pause());
 document.addEventListener('visibilitychange',()=>{if(document.hidden)video.pause();});
 const initial=Number(new URLSearchParams(location.search).get('tutorial'));
 select(Number.isInteger(initial)&&initial>=1&&initial<=5?initial-1:0,false);
})();


