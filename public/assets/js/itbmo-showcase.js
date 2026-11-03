/* ITBMO V297.6 · Faithful, interactive product showcase. */
(() => {
  'use strict';
  const lang=(document.documentElement.lang||'es').toLowerCase().startsWith('en')?'en':'es';
  const demo=document.querySelector('[data-workspace-demo]');
  if(!demo)return;

  const es=lang==='es';
  const labels=es?{
    journey:'RECORRIDO REAL EN ITBMO',trips:'Mis viajes',cities:'Todas las ciudades',city:'Madrid',route:'Rutas del día',prepare:'Para tu viaje',
    open:'Abrir viaje →',explore:'Explorar →',details:'Ver detalles +',hide:'Ocultar detalles −',options:'Ver opciones →'
  }:{
    journey:'THE REAL ITBMO JOURNEY',trips:'My trips',cities:'All cities',city:'Madrid',route:'Day routes',prepare:'For your trip',
    open:'Open trip →',explore:'Explore →',details:'View details +',hide:'Hide details −',options:'View options →'
  };
  const routeLabels={trips:labels.trips,cities:labels.cities,city:labels.city,route:labels.route,prepare:labels.prepare};
  const cityNames=['Madrid','Segovia','Toledo','Barcelona','Montserrat','Girona'];
  const cityDates=es?['1 may 2027 – 5 may 2027','2 may 2027','4 may 2027','5 may 2027 – 9 may 2027','6 may 2027','9 may 2027']:['May 1–5, 2027','May 2, 2027','May 4, 2027','May 5–9, 2027','May 6, 2027','May 9, 2027'];
  const cityDays=[5,1,1,5,1,1];

  const tripCard=(number,title,meta,opens=false)=>`<article class="hc-mini-trip"><small>${number}</small><h4>${title}</h4><p>${meta}</p><div><button class="hc-cta" type="button"${opens?' data-workspace-jump="cities"':''}>${labels.open}</button><span>↓ PDF</span><span>↓ Excel</span></div></article>`;
  const providerButtons=()=>`<div class="hc-provider-list"><span>GetYourGuide</span><button class="hc-provider-cta" type="button">${labels.options}</button><span>Viator</span><button class="hc-provider-cta" type="button">${labels.options}</button></div>`;
  const prepCard=(eyebrow,title,copy,badge)=>`<article><small>${eyebrow}</small><span class="hc-card-badge">${badge}</span><strong>${title}</strong><p>${copy}</p><button class="hc-detail-link" type="button">${labels.details}</button>${providerButtons()}</article>`;
  const routeOption=(title,copy)=>`<section><b>${title}</b><span>${copy}</span><button class="hc-provider-cta" type="button">Omio ↗</button><button class="hc-provider-cta" type="button">12Go ↗</button></section>`;
  const transportBlock=(eyebrow,title,copy,options)=>`<article class="hc-transport-block"><small>${eyebrow}</small><strong>${title}</strong><p>${copy}</p><div class="hc-route-options">${options}</div></article>`;

  const timeline=es?[
    ['13:00','13:25','Acceso local al Palacio Real','A pie · aproximadamente 20–25 min','Trayecto','Centro histórico de Madrid, preferentemente a pie o metro.','Transporte','A pie, aproximadamente 20–25 min; transporte urbano si el punto de partida queda más alejado.'],
    ['13:25','15:25','Visita del Palacio Real de Madrid','Actividad · 2 h','Trayecto','Palacio Real de Madrid – Palacio Real de Madrid','Detalles','Entrada y posible acceso con hora asignada. Conviene verificar horarios, cierres o restricciones especiales del 1 de mayo de 2027.'],
    ['15:25','16:10','Almuerzo y pausa en el entorno de Ópera','Actividad · 45 min','Trayecto','Palacio Real de Madrid – Plaza de Oriente','Detalles','Mantén la comida en el entorno de Ópera para no romper el recorrido.'],
    ['16:10','16:55','Visita de la Catedral de la Almudena','Actividad · 45 min','Trayecto','Plaza de Oriente – Catedral de la Almudena','Duración','Actividad: 45 min'],
    ['16:55','17:10','Recorrido peatonal por el Madrid de los Austrias','A pie · aproximadamente 15 min','Trayecto','Almudena – Plaza Mayor','Detalles','Recorrido conectado con la secuencia geográfica del día.'],
    ['17:10','18:10','Plaza Mayor y recorrido por el centro histórico','Actividad · 1 h','Trayecto','Plaza Mayor – Puerta del Sol','Detalles','Cierre flexible del primer día en Madrid.']
  ]:[
    ['13:00','13:25','Local access to the Royal Palace','Walk · approximately 20–25 min','Route','Madrid historic center, preferably on foot or by metro.','Transport','Walk, approximately 20–25 min; public transport if the starting point is farther away.'],
    ['13:25','15:25','Royal Palace of Madrid','Activity · 2 h','Route','Royal Palace of Madrid – Royal Palace of Madrid','Details','Entry may have an assigned time. Confirm schedules, closures and special restrictions for May 1, 2027.'],
    ['15:25','16:10','Lunch break near Ópera','Activity · 45 min','Route','Royal Palace of Madrid – Plaza de Oriente','Details','Keep lunch near Ópera so the route remains coherent.'],
    ['16:10','16:55','Almudena Cathedral','Activity · 45 min','Route','Plaza de Oriente – Almudena Cathedral','Duration','Activity: 45 min'],
    ['16:55','17:10','Walk through Madrid de los Austrias','Walk · approximately 15 min','Route','Almudena – Plaza Mayor','Details','A short connection that preserves the day’s geography.'],
    ['17:10','18:10','Plaza Mayor and the historic center','Activity · 1 h','Route','Plaza Mayor – Puerta del Sol','Details','A flexible close to the first day in Madrid.']
  ];
  const timelineCards=timeline.map((item,index)=>`<article class="hc-timeline-card${index<3?' is-open':''}"><time>${item[0]}<small>${item[1]}</small></time><div><strong>${item[2]}</strong><span>${item[3]}</span><button class="hc-detail-toggle" type="button" aria-expanded="${index<3}">${index<3?labels.hide:labels.details}</button><div class="hc-timeline-detail"${index<3?'':' hidden'}><p><b>${item[4]}</b>${item[5]}</p><p><b>${item[6]}</b>${item[7]}</p></div></div></article>`).join('');

  const cities=cityNames.map((name,index)=>`<article><small>${String(index+1).padStart(2,'0')}</small><span>${cityDates[index]}</span><strong>${name}</strong><p>${cityDays[index]} ${es?(cityDays[index]===1?'día organizado':'días organizados'):(cityDays[index]===1?'organized day':'organized days')}</p>${index===0?`<button class="hc-mini-cta" type="button" data-workspace-jump="city">${labels.explore}</button>`:`<i class="hc-mini-cta">${labels.explore}</i>`}</article>`).join('');

  const ticketCards=es?[
    ['DÍA 1 · 1 MAY 2027','Palacio Real de Madrid','Necesitas entrada para visitar el interior del Palacio Real. Comprueba también si se aplica acceso con hora asignada y las condiciones del 1 de mayo de 2027.','Entrada necesaria'],
    ['DÍA 3 · 3 MAY 2027','Museo del Prado','Prepara la entrada necesaria para visitar el Museo del Prado según tu itinerario.','Entrada necesaria'],
    ['DÍA 1 · 1 MAY 2027','Catedral de la Almudena','Verifica antes de ir las condiciones de acceso, la actividad litúrgica y si la cripta está abierta; la visita exterior sigue siendo posible.','Conviene reservar'],
    ['DÍA 5 · 5 MAY 2027','Templo de Debod','Comprueba antes de ir si el interior está abierto o sujeto a restricciones; el exterior y el mirador no dependen de esa gestión.','Conviene reservar']
  ]:[
    ['DAY 1 · MAY 1, 2027','Royal Palace of Madrid','You need a ticket to visit the Royal Palace interior. Confirm assigned entry times and May 1 conditions.','Ticket needed'],
    ['DAY 3 · MAY 3, 2027','Prado Museum','Prepare the admission ticket that matches your itinerary.','Ticket needed'],
    ['DAY 1 · MAY 1, 2027','Almudena Cathedral','Check access, liturgical activity and crypt opening before visiting.','Worth booking'],
    ['DAY 5 · MAY 5, 2027','Temple of Debod','Check whether the interior is open; the exterior and viewpoint remain independent.','Worth booking']
  ];
  const tourCards=es?[
    ['RECOMENDADO PARA CONOCER EL DESTINO','City Tour de Madrid','Compra una visita panorámica guiada de Madrid con tu recorrido por cuenta propia; es una opción general y no reemplaza las actividades ya planificadas.','Opcional'],
    ['DÍA 1 · 1 MAY 2027','Catedral de la Almudena','Una visita guiada puede aportar contexto y ayudarte a aprovechar mejor la Catedral.','Opcional'],
    ['DÍA 1 · 1 MAY 2027','Palacio Real de Madrid','Una visita guiada puede aportar contexto sin sustituir la entrada requerida.','Opcional'],
    ['DÍA 3 · 3 MAY 2027','Museo del Prado','Una visita guiada puede sumar contexto a la visita prevista en tu ruta.','Opcional'],
    ['DÍA 5 · 5 MAY 2027','Templo de Debod','Una visita guiada puede ayudarte a comprender mejor el lugar.','Opcional']
  ]:[
    ['RECOMMENDED TO DISCOVER THE DESTINATION','Madrid City Tour','Add a general guided overview without replacing the activities already planned.','Optional'],
    ['DAY 1 · MAY 1, 2027','Almudena Cathedral','A guided visit can provide context and help you get more from the cathedral.','Optional'],
    ['DAY 1 · MAY 1, 2027','Royal Palace of Madrid','A guided visit can add context without replacing the required ticket.','Optional'],
    ['DAY 3 · MAY 3, 2027','Prado Museum','A guided visit can add context to the visit already in your route.','Optional'],
    ['DAY 5 · MAY 5, 2027','Temple of Debod','A guided visit can help explain the site and its setting.','Optional']
  ];
  const tickets=ticketCards.map(item=>prepCard(...item)).join('');
  const tours=tourCards.map(item=>prepCard(...item)).join('');
  const move=es?`
    <article class="hc-transfer-card"><small>30 ABR 2027</small><strong>San José, CR → Madrid</strong><p>Este trayecto forma parte de tu recorrido. Compara la opción que mejor encaje con tus horarios y preferencias.</p></article>
    ${transportBlock('DÍA 2 · 2 MAY 2027','Madrid – Segovia','Compara opciones para tu excursión de un día.',routeOption('Madrid → Segovia','Tren · 08:00–08:55')+routeOption('Segovia → Madrid','Tren · 18:00–18:55'))}
    ${transportBlock('DÍA 4 · 4 MAY 2027','Madrid – Toledo','Compara opciones para tu excursión de un día.',routeOption('Madrid → Toledo','Tren · 08:30–09:05')+routeOption('Toledo → Madrid','Tren · 18:30–19:05'))}
    ${transportBlock('DÍA 5 · 5 MAY 2027','Madrid – Barcelona','Compara el traslado principal entre ciudades.',routeOption('Madrid → Barcelona','Tren · 08:45–11:30'))}
    <article class="hc-transfer-card"><small>10 MAY 2027</small><strong>Madrid → San José, CR</strong><p>Este trayecto forma parte del cierre de tu recorrido.</p></article>`:`
    <article class="hc-transfer-card"><small>APR 30, 2027</small><strong>San José, CR → Madrid</strong><p>This route is part of your trip. Compare the option that best fits your schedule.</p></article>
    ${transportBlock('DAY 2 · MAY 2, 2027','Madrid – Segovia','Compare options for your day trip.',routeOption('Madrid → Segovia','Train · 08:00–08:55')+routeOption('Segovia → Madrid','Train · 18:00–18:55'))}
    ${transportBlock('DAY 4 · MAY 4, 2027','Madrid – Toledo','Compare options for your day trip.',routeOption('Madrid → Toledo','Train · 08:30–09:05')+routeOption('Toledo → Madrid','Train · 18:30–19:05'))}
    ${transportBlock('DAY 5 · MAY 5, 2027','Madrid – Barcelona','Compare the main connection between cities.',routeOption('Madrid → Barcelona','Train · 08:45–11:30'))}
    <article class="hc-transfer-card"><small>MAY 10, 2027</small><strong>Madrid → San José, CR</strong><p>This route is part of the end of your trip.</p></article>`;

  demo.innerHTML=`
    <div class="hc-workspace__journey"><span>${labels.journey}</span><strong data-workspace-step>1 ${es?'de':'of'} 5 · ${labels.trips}</strong></div>
    <div class="hc-workspace__rail" role="tablist" aria-label="${es?'Recorrido de un viaje generado':'Generated trip journey'}">
      <button class="is-active" type="button" role="tab" aria-selected="true" data-workspace-tab="trips">1 · ${labels.trips}</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="cities">2 · ${labels.cities}</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="city">3 · Madrid</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="route">4 · ${labels.route}</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="prepare">5 · ${labels.prepare}</button>
    </div>
    <div class="hc-workspace__screen">
      <section class="hc-ws-panel is-active" data-workspace-panel="trips">
        <div class="hc-ws-launches"><article class="hc-ws-launch hc-ws-launch--continue"><small>${es?'ÚLTIMO VIAJE':'LAST TRIP'}</small><h3>${es?'Continuar con mi último viaje':'Continue my latest trip'}</h3><p>Cusco · 1 ${es?'ciudad':'city'} · 6 ${es?'días':'days'}</p><button type="button" data-workspace-jump="cities">${es?'Abrir Trip Workspace →':'Open Trip Workspace →'}</button></article><article class="hc-ws-launch"><small>${es?'NUEVA AVENTURA':'NEW ADVENTURE'}</small><h3>${es?'Planificar un nuevo viaje':'Plan a new trip'}</h3><p>${es?'Empieza desde cero sin borrar los viajes que ya creaste.':'Start from scratch without deleting trips already created.'}</p><span>${es?'Crear nuevo itinerario →':'Create new itinerary →'}</span></article></div>
        <div class="hc-ws-head hc-ws-head--left"><small>${es?'TU HISTORIAL':'YOUR HISTORY'}</small><h3>${labels.trips}</h3><p>${es?'Una muestra representativa: cada viaje conserva el acceso y sus descargas.':'A representative sample: each trip preserves access and downloads.'}</p></div>
        <div class="hc-trip-shelf">${tripCard('01','Madrid · Segovia · Toledo · Barcelona · Montserrat · Girona',es?'1 may 2027 · 6 ciudades · 10 días':'May 1, 2027 · 6 cities · 10 days',true)}${tripCard('02','Reikiavik',es?'1 nov 2026 · 1 ciudad · 7 días':'Nov 1, 2026 · 1 city · 7 days')}${tripCard('03','Cusco',es?'1 mar 2027 · 1 ciudad · 6 días':'Mar 1, 2027 · 1 city · 6 days')}</div>
      </section>
      <section class="hc-ws-panel" data-workspace-panel="cities">
        <div class="hc-ws-head"><small>${es?'TU VIAJE ITBMO':'YOUR ITBMO TRIP'}</small><h3>${es?'¿Por dónde quieres empezar?':'Where do you want to start?'}</h3><p>${es?'Elige una ciudad para explorarla día a día y preparar lo que realmente necesitas.':'Choose a city to explore day by day and prepare what you truly need.'}</p><span class="hc-trip-count">6 ${es?'ciudades · 14 días':'cities · 14 days'}</span></div>
        <div class="hc-trip-helper"><div><small>${es?'ANTES DE ELEGIR':'BEFORE YOU CHOOSE'}</small><strong>${es?'Prepara lo esencial de tu viaje':'Prepare your trip essentials'}</strong><span>${es?'Conectividad, movilidad y servicios útiles organizados según tu viaje.':'Connectivity, mobility and useful services organized around your trip.'}</span></div><button class="hc-cta hc-cta--warm" type="button">${es?'Ver lo que puedo necesitar →':'See what I may need →'}</button></div>
        <div class="hc-city-grid">${cities}</div>
        <div class="hc-global-help"><div class="hc-global-help__intro"><small>${es?'PARA TODO TU VIAJE':'FOR YOUR WHOLE TRIP'}</small><strong>${es?'Lo esencial viaja contigo.':'The essentials travel with you.'}</strong><span>${es?'Recomendaciones generales de conectividad y protección, relacionadas con tu recorrido.':'General connectivity and protection recommendations related to your route.'}</span></div><article><small>${es?'VIAJE CONECTADO':'CONNECTED TRIP'}</small><b>${es?'Conectividad':'Connectivity'}</b><span>${es?'Opciones de eSIM para mantenerte conectado durante todo el viaje.':'eSIM options to keep you connected throughout the trip.'}</span><em class="hc-offer">${es?'5% de descuento Holafly · código ITBMO':'5% Holafly discount · code ITBMO'}</em><button class="hc-provider-cta" type="button">${es?'Ver opciones →':'View options →'}</button></article><article><small>${es?'VIAJE SEGURO':'TRIP PROTECTION'}</small><b>${es?'Seguro de viaje':'Travel insurance'}</b><span>${es?'Protección que puede aportar valor real cuando existe una opción adecuada.':'Protection that may add real value when an option fits.'}</span><button class="hc-provider-cta" type="button">${es?'Ver opciones →':'View options →'}</button></article><p class="hc-global-help__note">${es?'Transparencia de enlaces: algunos pueden ser enlaces afiliados. Si reservas a través de ellos, ITBMO puede recibir una comisión del proveedor, sin costo adicional para ti.':'Link transparency: some may be affiliate links. If you book through them, ITBMO may receive a provider commission at no extra cost to you.'}</p></div>
        <div class="hc-feedback"><span>✦</span><div><small>${es?'AYÚDANOS A AFINAR ITBMO':'HELP US IMPROVE ITBMO'}</small><strong>${es?'¿Cómo calificarías la calidad general de tu itinerario?':'How would you rate the overall quality of your itinerary?'}</strong><p>${es?'Evalúa la organización, coherencia y utilidad del viaje completo.':'Rate the organization, coherence and usefulness of the complete trip.'}</p></div><div class="hc-stars">☆ ☆ ☆ ☆ ☆</div></div>
      </section>
      <section class="hc-ws-panel" data-workspace-panel="city">
        <div class="hc-city-toolbar"><button type="button" data-workspace-jump="cities">← ${labels.cities}</button><div><small>${es?'TU CIUDAD':'YOUR CITY'}</small><h3>Madrid</h3><span>${cityDates[0]}</span></div><div class="hc-city-mode"><b>⌁ ${es?'Itinerario':'Itinerary'}</b><button type="button" data-workspace-jump="prepare">✦ ${labels.prepare}</button></div></div>
        <div class="hc-day-chips"><b>${es?'Día':'Day'} 1 · ${es?'1 may 2027':'May 1, 2027'}</b><span>${es?'Día 2 · 2 may':'Day 2 · May 2'}</span><span>${es?'Día 3 · 3 may':'Day 3 · May 3'}</span><span>${es?'Día 4 · 4 may':'Day 4 · May 4'}</span><span>${es?'Día 5 · 5 may':'Day 5 · May 5'}</span></div>
        <div class="hc-city-route-callout"><div><small>${es?'RUTAS DEL DÍA':'DAY ROUTES'}</small><strong>${es?'Muévete con tu itinerario':'Move with your itinerary'}</strong><span>${es?'Abre una ruta sólo cuando la necesites.':'Open a route only when you need it.'}</span></div><button type="button" data-workspace-jump="route">${es?'Preparar ruta →':'Prepare route →'}</button></div>
        <div class="hc-itinerary-heading"><div><small>MADRID</small><h4>${es?'Día 1 · 1 may 2027':'Day 1 · May 1, 2027'}</h4></div><span>1 / 5</span></div><div class="hc-timeline hc-timeline--faithful">${timelineCards}</div>
      </section>
      <section class="hc-ws-panel" data-workspace-panel="route">
        <div class="hc-city-toolbar hc-city-toolbar--compact"><button type="button" data-workspace-jump="city">← ${es?'Itinerario':'Itinerary'}</button><div><small>MADRID · ${es?'DÍA 1':'DAY 1'}</small><h3>${es?'Muévete con tu itinerario':'Move with your itinerary'}</h3><span>${es?'Google Maps y Waze cuando los necesitas.':'Google Maps and Waze whenever you need them.'}</span></div></div>
        <div class="hc-route-box"><label>${es?'Desde':'From'}<strong>${es?'Palacio Real de Madrid':'Royal Palace of Madrid'}</strong></label><label>${es?'Hasta':'To'}<strong>Plaza de Oriente</strong></label><div class="hc-route-points"><span><b>13:00</b> ${es?'Palacio Real':'Royal Palace'}</span><span><b>15:25</b> Plaza de Oriente</span><span><b>16:10</b> Almudena</span><span><b>16:55</b> Plaza Mayor</span></div><div class="hc-route-actions"><button>◉ ${es?'Usar mi ubicación':'Use my location'}</button><button class="is-primary">${es?'Preparar ruta':'Prepare route'}</button><button>Google Maps ↗</button><button>Waze ↗</button></div><p>${es?'Tu ubicación se solicita sólo cuando la usas y no se guarda en ITBMO.':'Your location is requested only when used and is never stored by ITBMO.'}</p></div>
      </section>
      <section class="hc-ws-panel" data-workspace-panel="prepare">
        <div class="hc-city-toolbar"><button type="button" data-workspace-jump="cities">← ${labels.cities}</button><div><small>${es?'TU CIUDAD':'YOUR CITY'}</small><h3>Madrid</h3><span>${cityDates[0]}</span></div><div class="hc-city-mode"><button type="button" data-workspace-jump="city">⌁ ${es?'Itinerario':'Itinerary'}</button><b>✦ ${labels.prepare}</b></div></div>
        <div class="hc-prepare-hero"><span>✦</span><div><small>MADRID</small><h4>${es?'Tu itinerario es solo el comienzo. Prepárate para vivirlo.':'Your itinerary is only the beginning. Get ready to live it.'}</h4><p>${es?'Entradas, reservas, experiencias y movilidad, seleccionadas según tu viaje.':'Tickets, bookings, experiences and mobility selected around your trip.'}</p></div></div>
        <div class="hc-prepare-tabs" role="tablist"><button class="is-active" type="button" aria-selected="true" data-prepare-tab="tickets">${es?'Entradas y reservas':'Tickets and reservations'}</button><button type="button" aria-selected="false" data-prepare-tab="tours">${es?'Tours y experiencias':'Tours and experiences'}</button><button type="button" aria-selected="false" data-prepare-tab="move">${es?'Cómo moverte':'How to move'}</button></div>
        <div class="hc-prepare-view is-active" data-prepare-view="tickets"><div class="hc-section-title"><span>⌁</span><div><h4>${es?'Entradas y reservas':'Tickets and reservations'}</h4><p>${es?'Accesos, horarios y reservas que realmente requiere tu itinerario.':'Access, schedules and bookings your itinerary actually requires.'}</p></div></div><div class="hc-entry-grid">${tickets}</div></div>
        <div class="hc-prepare-view" data-prepare-view="tours"><div class="hc-section-title hc-section-title--violet"><span>✦</span><div><h4>${es?'Tours y experiencias':'Tours and experiences'}</h4><p>${es?'Alternativas guiadas y experiencias que encajan con lo que ya planeaste.':'Guided alternatives and experiences that fit what you already planned.'}</p></div></div><div class="hc-entry-grid">${tours}</div></div>
        <div class="hc-prepare-view" data-prepare-view="move"><div class="hc-section-title hc-section-title--cyan"><span>↗</span><div><h4>${es?'Cómo moverte':'How to move'}</h4><p>${es?'Opciones útiles de movilidad relacionadas con esta ciudad.':'Useful mobility options related to this city.'}</p></div></div><div class="hc-mobility-list">${move}</div></div>
      </section>
    </div>`;

  const tabs=[...demo.querySelectorAll('[data-workspace-tab]')];
  const panels=[...demo.querySelectorAll('[data-workspace-panel]')];
  const open=key=>{
    panels.forEach(panel=>panel.classList.toggle('is-active',panel.dataset.workspacePanel===key));
    const active=tabs.find(tab=>tab.dataset.workspaceTab===key);
    tabs.forEach(tab=>{const on=tab===active;tab.classList.toggle('is-active',on);tab.setAttribute('aria-selected',String(on));});
    const step=demo.querySelector('[data-workspace-step]');
    if(step)step.textContent=`${tabs.indexOf(active)+1} ${es?'de':'of'} ${tabs.length} · ${routeLabels[key]||''}`;
  };
  demo.addEventListener('click',event=>{
    const jump=event.target.closest('[data-workspace-jump]');
    if(jump){open(jump.dataset.workspaceJump);return;}
    const tab=event.target.closest('[data-workspace-tab]');
    if(tab){open(tab.dataset.workspaceTab);return;}
    const prep=event.target.closest('[data-prepare-tab]');
    if(prep){
      demo.querySelectorAll('[data-prepare-tab]').forEach(button=>{const on=button===prep;button.classList.toggle('is-active',on);button.setAttribute('aria-selected',String(on));});
      demo.querySelectorAll('[data-prepare-view]').forEach(view=>view.classList.toggle('is-active',view.dataset.prepareView===prep.dataset.prepareTab));
      return;
    }
    const detail=event.target.closest('.hc-detail-toggle');
    if(detail){const card=detail.closest('.hc-timeline-card'),panel=card?.querySelector('.hc-timeline-detail'),expanded=detail.getAttribute('aria-expanded')==='true';detail.setAttribute('aria-expanded',String(!expanded));detail.textContent=expanded?labels.details:labels.hide;card?.classList.toggle('is-open',!expanded);if(panel)panel.hidden=expanded;}
  });
})();
