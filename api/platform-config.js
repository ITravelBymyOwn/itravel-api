import { featureFlags, safeHttpsUrl, supabaseFetch } from './_lib/platform-core.js';

const DEFAULT_SOCIALS=[
 ['instagram','Instagram','https://www.instagram.com/itravelbymyown/'],
 ['facebook','Facebook','https://www.facebook.com/people/Itravelbymyown/61588326876876/'],
 ['tiktok','TikTok','https://www.tiktok.com/@itravelbymyown'],
 ['youtube','YouTube','https://www.youtube.com/@itravelbymyown']
];

export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({ok:false,code:'METHOD_NOT_ALLOWED'});
  res.setHeader('Cache-Control','public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  const flags=await featureFlags();let socials=[];
  if(flags.social_links_enabled){
    try{const rows=await supabaseFetch('/social_accounts?select=platform,account_name,public_url&enabled=eq.true&status=in.(active,approved,connected)&order=platform.asc');socials=(rows||[]).map(row=>({platform:String(row.platform||'').toLowerCase(),label:String(row.account_name||row.platform||'').slice(0,60),url:safeHttpsUrl(row.public_url)})).filter(x=>x.platform&&x.url)}catch(_){ }
    if(!socials.length)socials=DEFAULT_SOCIALS.map(([platform,label,url])=>({platform,label,url}));
  }
  const whatsappUrl=safeHttpsUrl(process.env.ITBMO_WHATSAPP_URL);
  const webChatScript=safeHttpsUrl(process.env.ITBMO_WEB_CHAT_SCRIPT_URL);
  res.status(200).json({ok:true,version:'V295',flags,social_accounts:socials,support:{email:'support@itravelbymyown.com',whatsapp_url:whatsappUrl,web_chat:webChatScript?{provider:String(process.env.ITBMO_WEB_CHAT_PROVIDER||'custom').slice(0,40),script_url:webChatScript}:null},live:{gateway_configured:Boolean(safeHttpsUrl(process.env.ITBMO_LIVE_GATEWAY_URL)),location_persisted:false}});
}
