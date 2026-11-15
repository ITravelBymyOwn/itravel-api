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
  updateModalNavigation();
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('tutorial',String(selected+1));url.hash='tutoriales';history.replaceState(null,'',url);if(!modal.open&&window.matchMedia('(max-width:1000px)').matches)gallery.querySelector('.tg-feature').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});}
 }
 function play(expand=false){
  if(expand)openModal();
  end.hidden=true;
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
 previous.addEventListener('click',()=>{select(selected-1);play();});
 next.addEventListener('click',()=>{select(selected+1);play();});
 watch.addEventListener('click',()=>play(true));
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
 const modalNav=document.createElement('nav');modalNav.className='tg-modal-nav';modalNav.setAttribute('aria-label',es?'Navegación de tutoriales':'Tutorial navigation');
 function navButton(){const button=document.createElement('button');button.type='button';const label=document.createElement('span'),detail=document.createElement('small');button.append(label,detail);modalNav.append(button);return {button,label,detail};}
 const modalPrevious=navButton(),modalReplay=navButton(),modalNext=navButton();
 modalReplay.button.className='is-replay';modal.append(modalNav);
 function updateModalNavigation(){
  modalPrevious.button.disabled=selected===0;modalNext.button.disabled=selected===buttons.length-1;
  modalPrevious.label.textContent=es?'← Anterior':'← Previous';modalNext.label.textContent=es?'Siguiente →':'Next →';modalReplay.label.textContent=es?'Repetir':'Replay';
  modalPrevious.detail.textContent=buttons[selected-1]?.querySelector('.tg-lesson-copy strong').textContent||(es?'Inicio del recorrido':'Start of walkthrough');
  modalNext.detail.textContent=buttons[selected+1]?.querySelector('.tg-lesson-copy strong').textContent||(es?'Fin del recorrido':'End of walkthrough');
  modalReplay.detail.textContent=buttons[selected].querySelector('.tg-lesson-copy strong').textContent;
 }
 modalPrevious.button.addEventListener('click',()=>{if(selected>0){select(selected-1);play();}});
 modalNext.button.addEventListener('click',()=>{if(selected<buttons.length-1){select(selected+1);play();}});
 modalReplay.button.addEventListener('click',()=>{video.currentTime=0;play();});
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

 function updateHeaderOffset(){const header=document.querySelector('header');gallery.style.setProperty('--tg-header-offset',Math.max(12,Math.ceil(header?header.getBoundingClientRect().bottom:68)+12)+'px');}
 updateHeaderOffset();window.addEventListener('resize',updateHeaderOffset);
 function resumeIfPlaying(wasPlaying){if(wasPlaying){const promise=video.play();if(promise)promise.catch(()=>{watch.hidden=false;});}}
 function openModal(){
  if(modal.open)return;
  const wasPlaying=!video.paused&&!video.ended;
  modal.insertBefore(screen,modalNav);modal.showModal();document.documentElement.classList.add('tg-modal-open');
  resumeIfPlaying(wasPlaying);
 }
 close.addEventListener('click',()=>modal.close());
 modal.addEventListener('close',()=>{
  const wasPlaying=!video.paused&&!video.ended;
  slot.append(screen);document.documentElement.classList.remove('tg-modal-open');
  slot.scrollIntoView({behavior:'instant',block:'start'});resumeIfPlaying(wasPlaying);
 });
 gallery.querySelector('#tg-fullscreen').addEventListener('click',openModal);
 // Native video controls can also start playback without the watch overlay.
 video.addEventListener('play',()=>{if(!video.dataset.started){video.dataset.started='true';openModal();}});
 window.addEventListener('pagehide',()=>video.pause());
 document.addEventListener('visibilitychange',()=>{if(document.hidden)video.pause();});
 const initial=Number(new URLSearchParams(location.search).get('tutorial'));
 select(Number.isInteger(initial)&&initial>=1&&initial<=5?initial-1:0,false);
})();


