import { resolveSession } from './_lib/itbmo-foundation.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const recentSends = globalThis.__itbmoRecentEmailSends || (globalThis.__itbmoRecentEmailSends=new Map());
const ALLOWED_FILES = new Map([
  ['itinerary_pdf','application/pdf'],
  ['itinerary_xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['receipt_pdf','application/pdf']
]);

function send(res,status,payload){ res.status(status).json(payload); }
function text(value,max=500){ return String(value||'').trim().slice(0,max); }
function email(value){
  const out=text(value,254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out) ? out : '';
}
function escapeHtml(value){
  return String(value||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function validBase64(value){ return typeof value==='string' && value.length>0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value); }

async function sendBrevo(payload,senderEmail){
  const apiKey=process.env.BREVO_API_KEY;
  if(!apiKey || !senderEmail){
    const err=new Error('EMAIL_NOT_CONFIGURED'); err.code='EMAIL_NOT_CONFIGURED'; throw err;
  }
  const response=await fetch(BREVO_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json','api-key':apiKey},
    body:JSON.stringify({sender:{email:senderEmail,name:text(process.env.BREVO_SENDER_NAME||'I Travel By My Own',70)},...payload})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    console.error('ITBMO Brevo send failed',{status:response.status,code:data?.code,message:data?.message});
    const err=new Error('EMAIL_PROVIDER_FAILED'); err.code='EMAIL_PROVIDER_FAILED'; throw err;
  }
  return data;
}

export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  try{
    const body=req.body||{};
    const session=await resolveSession(body.session_token).catch(()=>null);
    if(!session) return send(res,401,{ok:false,code:'SESSION_REQUIRED'});
    const action=text(body.action,40);
    const rateKey=`${session.id}:${action}`;
    const now=Date.now(),windowStart=now-(10*60*1000);
    const recent=(recentSends.get(rateKey)||[]).filter(ts=>ts>windowStart);
    if(recent.length>=5) return send(res,429,{ok:false,code:'EMAIL_RATE_LIMIT'});
    const tripId=text(body.trip_id,80)||'N/A';
    const lang=body.lang==='en'?'en':'es';

    if(action==='support_request'){
      const replyTo=email(body.contact_email);
      const message=text(body.message,4000);
      const category=text(body.category,80);
      if(!replyTo || message.length<10) return send(res,400,{ok:false,code:'SUPPORT_FIELDS_REQUIRED'});
      const supportEmail=email(process.env.BREVO_SUPPORT_EMAIL);
      const senderEmail=email(process.env.BREVO_SUPPORT_SENDER_EMAIL)||email(process.env.BREVO_SENDER_EMAIL);
      if(!supportEmail || !senderEmail) return send(res,503,{ok:false,code:'EMAIL_NOT_CONFIGURED'});
      const cities=text(body.cities,500);
      const html=`<div style="font-family:Arial,sans-serif;color:#092c4c;line-height:1.55"><h2>Nueva solicitud de soporte ITBMO</h2><p><strong>Categoría:</strong> ${escapeHtml(category)}</p><p><strong>Trip ID:</strong> ${escapeHtml(tripId)}</p><p><strong>Email:</strong> ${escapeHtml(replyTo)}</p><p><strong>Destinos:</strong> ${escapeHtml(cities||'N/A')}</p><hr><p style="white-space:pre-wrap">${escapeHtml(message)}</p></div>`;
      const result=await sendBrevo({to:[{email:supportEmail,name:'ITBMO Customer Care'}],replyTo:{email:replyTo},subject:`ITBMO Support · ${category||'General'} · ${tripId}`,htmlContent:html,tags:['support-request']},senderEmail);
      recent.push(now);recentSends.set(rateKey,recent);
      return send(res,201,{ok:true,message_id:result?.messageId||null});
    }

    if(action==='send_itinerary'){
      const recipient=email(body.recipient_email);
      const senderEmail=email(process.env.BREVO_DOCUMENTS_SENDER_EMAIL)||email(process.env.BREVO_SENDER_EMAIL);
      const files=Array.isArray(body.attachments)?body.attachments:[];
      if(!recipient) return send(res,400,{ok:false,code:'INVALID_RECIPIENT'});
      if(!senderEmail) return send(res,503,{ok:false,code:'EMAIL_NOT_CONFIGURED'});
      if(files.length!==3) return send(res,400,{ok:false,code:'THREE_ATTACHMENTS_REQUIRED'});
      const seen=new Set(); let totalBytes=0;
      const attachments=[];
      for(const file of files){
        const kind=text(file?.kind,40),expected=ALLOWED_FILES.get(kind),name=text(file?.name,120);
        if(!expected || seen.has(kind) || text(file?.type,120)!==expected || !validBase64(file?.content) || !name) return send(res,400,{ok:false,code:'INVALID_ATTACHMENT'});
        if((kind.endsWith('_pdf')&&!name.toLowerCase().endsWith('.pdf')) || (kind==='itinerary_xlsx'&&!name.toLowerCase().endsWith('.xlsx'))) return send(res,400,{ok:false,code:'INVALID_ATTACHMENT_NAME'});
        totalBytes+=Buffer.byteLength(file.content,'base64');
        seen.add(kind); attachments.push({content:file.content,name});
      }
      if(totalBytes>MAX_ATTACHMENT_BYTES) return send(res,413,{ok:false,code:'ATTACHMENTS_TOO_LARGE',max_bytes:MAX_ATTACHMENT_BYTES});
      const subject=lang==='es'?`Tu itinerario ITBMO · ${tripId}`:`Your ITBMO itinerary · ${tripId}`;
      const html=lang==='es'
        ? `<div style="font-family:Arial,sans-serif;color:#092c4c;line-height:1.55"><h2>Tu viaje está listo</h2><p>Adjuntamos tu itinerario PDF, el Excel editable y el comprobante de pago.</p><p><strong>Trip ID:</strong> ${escapeHtml(tripId)}</p><p>Buen viaje,<br>I Travel By My Own</p></div>`
        : `<div style="font-family:Arial,sans-serif;color:#092c4c;line-height:1.55"><h2>Your trip is ready</h2><p>Your itinerary PDF, editable Excel workbook and payment receipt are attached.</p><p><strong>Trip ID:</strong> ${escapeHtml(tripId)}</p><p>Have a great trip,<br>I Travel By My Own</p></div>`;
      const result=await sendBrevo({to:[{email:recipient}],subject,htmlContent:html,attachment:attachments,tags:['itinerary-delivery']},senderEmail);
      recent.push(now);recentSends.set(rateKey,recent);
      return send(res,201,{ok:true,message_id:result?.messageId||null});
    }
    return send(res,400,{ok:false,code:'INVALID_ACTION'});
  }catch(error){
    const code=error?.code||'EMAIL_SEND_FAILED';
    return send(res,code==='EMAIL_NOT_CONFIGURED'?503:502,{ok:false,code});
  }
}
