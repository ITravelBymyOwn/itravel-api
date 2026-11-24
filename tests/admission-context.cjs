// Run with node --test tests/admission-context.cjs. No services or credentials.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const api=fs.readFileSync(path.join(root,'api/context.js'),'utf8').replace(/^import .*;\s*$/gm,'').replace('export default async function handler','async function handler');
const front=fs.readFileSync(path.join(root,'public/trip-workspace.js'),'utf8');
const itbmoAdmission=require('../public/assets/js/itbmo-admission.js');
const backend=vm.createContext({itbmoAdmission,OpenAI:function(){},process:{env:{}},console,setTimeout,clearTimeout});vm.runInContext(api,backend);
function extract(name){const start=front.indexOf('function '+name+'(');assert(start>=0,name);const tail=front.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return end<0?tail:tail.slice(0,end+1);}
let rows=[];
const ui=vm.createContext({itbmoAdmission,lang:'es',console,workspaceRowsForCity:()=>rows.map((row,index)=>({row,index,day:1})),v207ConsolidateJourneyNeeds:x=>x});
for(const name of ['normalizeWorkspaceEntity','workspaceEntityCore','workspaceEntityTokens','sameWorkspaceEntity','v198SameAdmissionDecision','admissionEvidenceFromText','rowHasAdmissionEvidence','workspaceRowsMatchingNeed','contextualCommerceNeedIsSane','localTicketNeedsForCity','dedupeContextualNeeds'])vm.runInContext(extract(name),ui);
const row=(name,notes,semantic='ATTRACTION_TICKET',ticket='required',eligible=true)=>({activity:`Visit ${name}`,notes,commerce_context:{canonical_place:name,semantic_type:semantic,ticket_need:ticket,commercial_eligible:eligible},physical_location:'Segovia'});
const need=(name,activity,type='ticket_required',id='test')=>({id:`${id}:${type}`,candidate_id:id,entity_name:name,source_activity:activity,category:'tickets',day:1,need_type:type});
const candidate=r=>({candidate_id:'test',activity:r.activity,notes:r.notes,entity_hint:r.commerce_context.canonical_place,commerce_semantic_type:r.commerce_context.semantic_type,commerce_ticket_need:r.commerce_context.ticket_need,commerce_commercial_eligible:r.commerce_context.commercial_eligible,access_hint:backend.accessEvidence(r).hint||(['required','recommended'].includes(r.commerce_context.ticket_need)?'ticket_required':'')});
test('different monuments sharing a destination stay separate; genuine aliases collapse',()=>{
 for(const [a,b] of [['Acueducto de Segovia','Catedral de Segovia'],['Catedral de Segovia','Alcázar de Segovia'],['Segovia Cathedral','Alcázar of Segovia'],['Catedral de Madrid','Palacio Real de Madrid'],['London Bridge','Tower Bridge London']])assert.equal(ui.sameWorkspaceEntity(a,b),false,`${a} / ${b}`);
 for(const [a,b] of [['Alcázar de Segovia','Alcazar de Segovia'],['Qorikancha y conjunto de Santo Domingo','Templo del Qorikancha'],['Visita guiada Catedral de Segovia','Catedral de Segovia']])assert.equal(ui.sameWorkspaceEntity(a,b),true,`${a} / ${b}`);
});
test('negative/free admission is rejected by API recovery and browser, even with stale paid metadata',()=>{
 for(const notes of ['Es una visita exterior y no requiere entrada.','Entrada gratuita.','No necesita entrada para esta visita.','No ticket is required.','Admission is free.','Tickets are not required.','No admission required.','This does not require a ticket.']){
  const r=row('Monumento del Centro',notes);assert.equal(backend.accessEvidence(r).hint,'',notes);assert.equal(backend.ensureEvidenceBackedAccessNeeds([candidate(r)],[],'Segovia','es').length,0,notes);assert.equal(ui.rowHasAdmissionEvidence(r),false,notes);
 }
});
test('structured free/none and ineligible rows cannot borrow admission evidence',()=>{
 rows=[row('Acueducto de Segovia','No depende de horarios de entrada.','FREE_SIGHT','none',false),row('Catedral de Segovia','Entrada necesaria para la visita.'),row('Alcázar de Segovia','Advance admission is advisable.','ATTRACTION_TICKET','recommended')];
 const wrong=need('Acueducto de Segovia',rows[0].activity);
 assert.equal(ui.contextualCommerceNeedIsSane(wrong,'Segovia'),false);
 assert.equal(ui.workspaceRowsMatchingNeed(wrong,'Segovia').length,1);
 assert.equal(backend.ensureEvidenceBackedAccessNeeds([candidate(rows[0])],[],'Segovia','es').length,0);
 const valid=rows.slice(1).map((r,i)=>need(r.commerce_context.canonical_place,r.activity,'ticket_required',`paid-${i}`));
 assert.equal(ui.dedupeContextualNeeds(valid).length,2);
 assert.equal(ui.localTicketNeedsForCity('Segovia',[]).length,2);
 assert.equal(ui.contextualCommerceNeedIsSane(need('Invented museum','Unknown visit'),'Segovia'),false);
});
test('interior visit retains admission when notes offer an exterior fallback',()=>{
 for(const notes of ['Entrada necesaria; si está cerrado, contempla una visita exterior como alternativa.','Advance admission is advisable. If interior access is restricted, use the castle exterior as the fallback.']){
  const r=row('Alcázar de Segovia',notes);assert.equal(ui.rowHasAdmissionEvidence(r),true);assert.equal(backend.ensureEvidenceBackedAccessNeeds([candidate(r)],[],'Segovia','en').length,1);
 }
});
test('cache reads revalidate their bound source; free admission cards cannot survive',async()=>{
 const r=row('Acueducto de Segovia','No requiere entrada.','FREE_SIGHT','none',false),c=candidate(r);
 const trip={id:'fixture',updated_at:'2026-11-16T00:00:00Z'};
 const n=need(c.entity_hint,c.activity);
 backend.supabaseFetch=async url=>url.startsWith('/trip_context_runs')?[{context_version:'test-v323',source_trip_updated_at:trip.updated_at}]:[n];
 const cached=await backend.getPersistedContext(trip,'Segovia','test-v323',[c]);assert.equal(cached.needs.length,0);
 assert.equal(await backend.getPersistedContext(trip,'Segovia','old-version',[c]),null);
 const paid=row('Catedral de Segovia','Entrada necesaria.');assert.equal(backend.filterUnsafeAdmissionNeeds([need('Catedral de Segovia',paid.activity)],[candidate(paid)]).length,1);
});
test('buildCandidates uses own structured facts and does not inherit transfer ticket prose',()=>{
 const paid=row('Catedral de Segovia','Entrada necesaria para visitar el interior.'),free=row('Acueducto de Segovia','No depende de horarios de entrada.','FREE_SIGHT','none',false);
 const trip={itinerary_data:{itineraries:{Madrid:{byDay:{2:[free,paid]}}}}};
 const built=backend.buildCandidates(trip,'Segovia').candidates;
 assert.equal(built.length,2);assert.equal(built[0].access_hint,'');assert.equal(built[1].access_hint,'ticket_required');
 const recovered=backend.ensureEvidenceBackedAccessNeeds(built,[],'Segovia','es');assert.equal(recovered.length,1);assert.equal(recovered[0].entity_name,'Catedral de Segovia');
});
test('an independent waterfall with parking and trail checks cannot produce admission or a standalone tour',()=>{
 const r=row('Seljalandsfoss','Prioritize the main waterfall viewpoint and the path behind the waterfall. Verify path access and expect a paid parking fee.');
 r.activity='Visit Seljalandsfoss and the surrounding waterfall area.';
 rows=[r];
 const c=candidate(r);
 const admission=need('Seljalandsfoss',r.activity,'reservation_recommended');
 const tour={...need('Seljalandsfoss',r.activity,'guided_tour_optional'),category:'tours',city:'Segovia'};
 const overview={...tour,entity_name:'Segovia city tour'};
 assert.equal(backend.accessEvidence(r).hint,'');
 assert.equal(backend.ensureEvidenceBackedAccessNeeds([c],[],'Segovia','en').length,0);
 assert.deepEqual(Array.from(backend.filterUnsafeAdmissionNeeds([admission,tour,overview],[c])),[overview]);
 assert.equal(ui.contextualCommerceNeedIsSane(admission,'Segovia'),false);
 assert.equal(ui.contextualCommerceNeedIsSane(tour,'Segovia'),false);
 assert.equal(ui.contextualCommerceNeedIsSane(overview,'Segovia'),true);
 assert.equal(ui.localTicketNeedsForCity('Segovia',[]).length,0);
 const built=backend.buildCandidates({itinerary_data:{itineraries:{Madrid:{byDay:{3:[r]}}}}},'Segovia').candidates;
 assert.equal(built[0].access_hint,'');
 const classified=['reservation_recommended','guided_tour_optional'].map(need_type=>({
  candidate_id:built[0].candidate_id,need_type,confidence:'high',entity_type:'attraction',entity_name:'Seljalandsfoss'
 }));
 assert.equal(backend.sanitizeClassifications(built,classified,'Segovia').length,0);
});
test('paid waterfall access, genuinely guided activities and a planned tower retain eligibility',()=>{
 for(const r of [
  row('Cascada del Parque','La visita requiere entrada. El estacionamiento se paga aparte.'),
  row('Falls Waterfall Park','Timed entry tickets are required.'),
  row('Guided Waterfall Canyoning','Book the guided experience.','TOUR_EXPERIENCE'),
  row('Blue Lagoon','Arrange admission in advance.'),
  row('Church Tower','Tower admission is required.')
 ]){
  rows=[r];
  const item=need(r.commerce_context.canonical_place,r.activity);
  assert.equal(backend.filterUnsafeAdmissionNeeds([item],[candidate(r)]).length,1,r.activity);
  assert.equal(ui.contextualCommerceNeedIsSane(item,'Segovia'),true,r.activity);
 }
 const church=row('Hallgrímskirkja','Prioritize the church interior and exterior architecture; tower access is a separate optional component. Verify the current schedule.');
 church.activity='Visit Hallgrímskirkja and its surrounding architectural setting';
 rows=[church];
 assert.equal(backend.ensureEvidenceBackedAccessNeeds([candidate(church)],[],'Segovia','en').length,0);
 assert.equal(ui.localTicketNeedsForCity('Segovia',[]).length,0);
});
