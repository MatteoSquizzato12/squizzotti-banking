/* Squizzotti's Banking: interfaccia. Classificazione ed esercenti stanno in js/logica.js; i movimenti arrivano dalla banca (supabase/functions/banca). */
const L=window.Logica;
const MESI=["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
const MESI3=["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
const CONTANTI="CONTANTI"; // causale dei movimenti fuori banca scritti a mano (il nome è rimasto quello della prima versione)
const nomeExtra=()=>S.conto==="anna"?"Rifle":"Altro"; // nome del pulsante e dell'etichetta: per Anna è "Rifle"
const RETTIFICA="RETTIFICA"; // correzione scritta a mano che non fa parte della scheda Altro
const CARTA="CARTA"; // movimenti della carta prepagata, letti da NEXI: non fanno parte del saldo del conto corrente
const CAUSALI={"CONTANTI":"Fuori banca","RETTIFICA":"Rettifica scritta a mano","CARTA":"Carta prepagata (NEXI)","(2":"Pagamento con carta","VH":"Pagamento POS","TE":"Addebito diretto","U2":"Utenza telefonica","M4":"Bonifico in uscita","W7":"Bonifico istantaneo in uscita","W8":"Bonifico istantaneo in entrata","BP":"Bonifico in entrata","3B":"Bonifico in entrata","B8":"Emolumenti","2U":"Ricarica prepagata","EB":"Commissioni","5E":"Commissioni bonifico","0F":"Commissioni prepagata","2J":"Commissioni prepagata","18":"Competenze e spese","4K":"Imposta di bollo","4Y":"Canone carta","FT":"F24","(0":"Prelievo","F8":"Rimborso"};
const COME={manuale:"Scelta a mano su questo movimento",regola:"Regola imparata",causale:"Riconosciuta dal codice causale della banca",dizionario:"Riconosciuta dall'elenco degli esercenti",predefinita:"Non riconosciuta"};
const PROTETTE=["da-classificare","altre-entrate","saldo-iniziale"]; // servono come ripiego o hanno un significato fisso: non si eliminano
const SALDO="saldo-iniziale"; // soldi portati dal vecchio conto: né entrate né giroconti
const filtriVuoti=()=>({cats:[],min:"",max:"",nota:false,manuale:false});

const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const EUR=new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"});
const eur=n=>EUR.format(Math.abs(n)<0.005?0:n);
const eurS=n=>(n>0.004?"+":"")+eur(n);
const compatto=n=>Math.abs(n)>=1000?(n/1000).toLocaleString("it-IT",{maximumFractionDigits:1})+"k":String(Math.round(n));
const ymAdd=(ym,n)=>{let [y,m]=ym.split("-").map(Number);m+=n;while(m>12){m-=12;y++;}while(m<1){m+=12;y--;}return y+"-"+String(m).padStart(2,"0");};
const ymOggi=()=>{const t=new Date();return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0");};
const ymNome=ym=>MESI[+ym.slice(5,7)-1]+" "+ym.slice(0,4);
const giorno=iso=>{const [y,m,d]=iso.split("-");return +d+" "+MESI3[+m-1]+" "+y;};
const nMov=(n,dove)=>`${n} ${n===1?"movimento":"movimenti"}${dove||""} ${n===1?"contiene":"contengono"} questo testo.`;
const mesiTra=(a,b)=>{const out=[];for(let x=a;x<=b;x=ymAdd(x,1))out.push(x);return out;};

function pref(k,d){try{return localStorage.getItem("bank:"+k)||d;}catch(e){return d;}}
function setPref(k,v){try{localStorage.setItem("bank:"+k,v);}catch(e){}}

// Ritorno dalla pagina della banca (consenso Enable Banking): ?state=…&code=… oppure ?error=…
// Si legge e si toglie dall'indirizzo prima che parta il client di Supabase.
let ritornoBanca=(()=>{const p=new URLSearchParams(location.search);
  const r=p.get("state")&&p.get("code")?{state:p.get("state"),code:p.get("code")}:p.get("error")?{errore:p.get("error_description")||p.get("error")}:null;
  if(r)history.replaceState(null,"",location.pathname);return r;})();
const sb=supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true}});
let user=null,persona=null,chan=null;
const S={conto:null,tab:"panoramica",per:"mese",mese:ymOggi(),q:"",verso:"tutti",dper:"12m",filtri:filtriVuoti(),lim:150,conferma:{},msg:"Carico i conti…"};
const D={conti:[],c:{},banca:{}}; // c[conto] = {mov, cats, regole, imps, obi, mesi}; banca[conto] = collegamento con la banca
let sheet=null;

/* ===================== dati ===================== */
async function tutte(q){
  const out=[];
  for(let da=0;;da+=1000){const {data,error}=await q().range(da,da+999);if(error)throw error;out.push(...data);if(data.length<1000)break;}
  return out;
}
const nonPronto=e=>e&&(/does not exist|schema cache|PGRST20[25]/i.test(e.message||"")||e.code==="42P01");
async function caricaConto(id){
  const q=t=>sb.from(t).select("*").eq("conto",id);
  const [cats,reg,imps,obi]=await Promise.all([q("categorie").order("ordine"),q("regole").order("creato"),q("importazioni").order("caricato",{ascending:false}),q("obiettivi").order("creato")]);
  for(const r of [cats,reg,imps,obi])if(r.error)throw r.error;
  let regole=reg.data;
  const mig=await migraCategorie(id,cats.data);
  if(mig){cats.data=mig;const r=await q("regole").order("creato");if(!r.error)regole=r.data;}
  const mov=await tutte(()=>sb.from("movimenti").select("id,data,valuta,importo,causale,descrizione,chiave,categoria,nota,importazione").eq("conto",id).order("data",{ascending:false}).order("id"));
  let categorie=cats.data;
  if(!categorie.length){ // primo accesso al conto: categorie predefinite
    categorie=L.categoriePredefinite(id);
    const {error}=await salvaCategorie(categorie);
    if(error)throw error;
  }
  if(!categorie.some(c=>c.id===SALDO)){
    const c=L.categoriePredefinite(id).find(c=>c.id===SALDO);
    const {error}=await salvaCategorie([c]);
    if(!error)categorie=categorie.concat(c);
  }
  mov.forEach(m=>m.importo=Number(m.importo));
  D.c[id]={mov,cats:categorie,regole,imps:imps.data,obi:obi.data.map(o=>({...o,importo:Number(o.importo)}))};
  prepara(id);
}
// Finché nel database manca la colonna "padre" (supabase/schema.sql non rieseguito) le categorie si salvano senza.
async function salvaCategorie(rows){
  let r=await sb.from("categorie").upsert(rows,{onConflict:"conto,id",ignoreDuplicates:true});
  if(r.error&&/padre/i.test(r.error.message||"")){rows.forEach(c=>delete c.padre);r=await sb.from("categorie").upsert(rows,{onConflict:"conto,id",ignoreDuplicates:true});}
  return r;
}
// Categorie v2 (19/10/2026): meno categorie, Auto con sottocategorie. Vale una volta sola, per i conti che hanno
// ancora le categorie della prima versione. Le categorie create a mano restano; movimenti e regole seguono le nuove.
async function migraCategorie(id,cats){
  const M=L.MIGRAZIONE_V2;
  if(!cats.length||cats.some(c=>c.id==="auto")||!cats.some(c=>c.id in M))return null;
  let r=await sb.from("categorie").upsert(L.categoriePredefinite(id),{onConflict:"conto,id"});
  if(r.error){console.warn("Categorie non aggiornate:",r.error.message);return null;} // es. manca la colonna "padre"
  for(const [da,a] of Object.entries(M)){
    if(!cats.some(c=>c.id===da))continue;
    await sb.from("movimenti").update({categoria:a}).eq("conto",id).eq("categoria",da);
    await sb.from("regole").update({categoria:a}).eq("conto",id).eq("categoria",da);
  }
  await sb.from("categorie").delete().eq("conto",id).in("id",Object.keys(M));
  r=await sb.from("categorie").select("*").eq("conto",id).order("ordine");
  return r.error?null:r.data;
}
// Ricalcola categoria, esercente e totali mensili (dopo ogni modifica a regole, categorie o movimenti).
function prepara(id){
  const C=D.c[id];if(!C)return;
  C.cats.sort((a,b)=>a.ordine-b.ordine||a.nome.localeCompare(b.nome,"it"));
  C.byId=Object.fromEntries(C.cats.map(c=>[c.id,c]));
  for(const c of C.cats)if(c.padre&&!C.byId[c.padre])c.padre=null; // categoria principale eliminata altrove
  C.cats=C.cats.filter(c=>!c.padre).flatMap(c=>[c,...C.cats.filter(x=>x.padre===c.id)]); // ogni sottocategoria subito dopo la sua principale
  const ctx={conto:id,cats:C.cats,regole:C.regole,ids:new Set(C.cats.map(c=>c.id))};
  for(const m of C.mov){m._c=L.classifica(m,ctx);m._e=L.esercente(m);}
  C.mesi={};
  for(const m of C.mov){const k=m.data.slice(0,7);(C.mesi[k]??=[]).push(m);}
  C.tot={};for(const k in C.mesi)C.tot[k]=totali(C.mesi[k],C);
  C.ultimo=C.mov.length?C.mov[0].data.slice(0,7):null;
  C.primo=C.mov.length?C.mov[C.mov.length-1].data.slice(0,7):null;
}
// Entrate/uscite si calcolano per categoria: un rimborso dentro "Spesa" riduce la spesa, non diventa un'entrata.
function totali(ms,C){
  const net={};let inv=0,tr=0,si=0;
  for(const m of ms){const cat=C.byId[m._c.id],tipo=cat?cat.tipo:"normale";
    if(m._c.id===SALDO)si+=m.importo; else if(tipo==="trasferimento")tr+=m.importo; else if(tipo==="investimento")inv-=m.importo; else net[m._c.id]=(net[m._c.id]||0)+m.importo;}
  let e=0,u=0;for(const k in net){if(net[k]>0)e+=net[k];else u-=net[k];}
  return {e,u,r:e-u,inv,tr,si,net};
}
const C0=()=>D.c[S.conto];
const visibili=()=>{const C=C0();if(!C)return [];
  if(S.per==="tutto")return C.mov;
  const p=S.per==="anno"?S.mese.slice(0,4):S.mese;return C.mov.filter(m=>m.data.startsWith(p));};
function totPeriodo(){const C=C0();if(S.per==="mese")return C.tot[S.mese]||totali([],C);return totali(visibili(),C);}
const daClassificare=ms=>ms.filter(m=>m._c.id==="da-classificare");
const nomeCat=id=>{const B=C0()?.byId||{},c=B[id];if(!c)return "Senza categoria";return c.padre&&B[c.padre]?B[c.padre].nome+" · "+c.nome:c.nome;};
const radice=id=>C0()?.byId[id]?.padre||id;
const figli=id=>(C0()?.cats||[]).filter(c=>c.padre===id);
// Chip delle categorie ad albero: una categoria con sottocategorie sta in un riquadro insieme a loro.
function chipsAlbero(cs,chip){
  const ids=new Set(cs.map(c=>c.id));
  return `<div class="chips">${cs.filter(c=>!c.padre||!ids.has(c.padre)).map(c=>{const fs=cs.filter(x=>x.padre===c.id);
    return fs.length?`<div class="cgruppo">${chip(c,false)}${fs.map(x=>chip(x,true)).join("")}</div>`:chip(c,false);}).join("")}</div>`;
}
const contoNome=id=>D.conti.find(c=>c.id===id)?.nome||id;
const personale=()=>S.conto&&S.conto!=="comune";

/* ===================== render ===================== */
function renderAll(){renderConti();renderTabs();renderMain();}
function renderConti(){
  $("conti").innerHTML=D.conti.map(c=>{const sub=c.id==="comune"?"Conto in comune":"Conto personale";
    return `<button class="conto" data-act="conto" data-id="${c.id}" aria-pressed="${S.conto===c.id}"><span class="av">${esc(c.nome[0])}</span><span>${esc(c.nome)}<small>${sub}</small></span></button>`;}).join("");
}
const ICONE={dashboard:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',altro:'<path d="M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 7l12-4v4"/><circle cx="16.5" cy="14" r="1.2"/>',panoramica:'<path d="M5 20V11M12 20V4M19 20v-6M3 20h18"/>',movimenti:'<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',categorie:'<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',obiettivi:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',banca:'<path d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>'};
function renderTabs(){
  const C=C0();
  const n=C?daClassificare(C.mov).length:0;
  const tabs=typeof dashOk==="function"&&dashOk()?[["dashboard","Dashboard"]]:[]; // la dashboard c'è solo su PC
  tabs.push(["panoramica","Panoramica"],["movimenti","Movimenti",n],["altro",nomeExtra()],["categorie","Categorie"]);
  if(personale())tabs.push(["obiettivi","Obiettivi"]);
  tabs.push(["banca","Banca"]);
  if(!tabs.some(t=>t[0]===S.tab))S.tab="panoramica";
  // Sul PC le sezioni stanno in un menu a tendina; sul telefono nella barra in basso (vedi app.css).
  const att=tabs.find(t=>t[0]===S.tab)||tabs[0],ic=id=>`<svg class="ti" viewBox="0 0 24 24" aria-hidden="true">${ICONE[id]}</svg>`,num=c=>c?`<span class="count" title="Da classificare">${c}</span>`:"";
  $("tabs").innerHTML=C?`<div class="menu"><button class="menubtn" data-act="menu" aria-haspopup="menu" aria-expanded="${!!S.menu}">${ic(att[0])}<span>${att[1]}</span>${num(att[2])}<span class="caret" aria-hidden="true">▾</span></button>
    ${S.menu?`<div class="menulist" role="menu">${tabs.map(([id,t,c])=>`<button role="menuitem" class="menuitem" data-act="tab" data-tab="${id}" aria-current="${S.tab===id}">${ic(id)}<span>${t}</span>${num(c)}</button>`).join("")}</div>`:""}</div>
    <div class="tabs" role="tablist">${tabs.map(([id,t,c])=>`<button class="tab" role="tab" data-act="tab" data-tab="${id}" aria-selected="${S.tab===id}">${ic(id)}<span class="tl">${t}</span>${c?`<span class="count" title="Da classificare">${c}</span>`:""}</button>`).join("")}</div>`:"";
}
function renderMain(){
  const C=C0(),el=$("main");
  if(!C){el.innerHTML=`<div class="loading">${S.msg}</div>`;return;}
  if(S.tab==="panoramica")el.innerHTML=vPanoramica(C);
  else if(S.tab==="movimenti"){el.innerHTML=vMovimenti(C);renderLista();}
  else if(S.tab==="categorie")el.innerHTML=vCategorie(C);
  else if(S.tab==="obiettivi")el.innerHTML=vObiettivi(C);
  else if(S.tab==="altro")el.innerHTML=vAltro(C);
  else if(S.tab==="dashboard")el.innerHTML=vDashboard(C);
  else el.innerHTML=vBanca(C);
  el.insertAdjacentHTML("beforeend",`<p class="meta" style="text-align:center;margin-top:36px">Accesso come ${esc(user?.email||"")} · <button class="linkbtn" data-act="logout">Log out</button></p>`);
  disegnaGrafici();tipTorta();if(S.tab==="dashboard")disegnaDashboard();
  document.body.classList.toggle("wide",S.tab==="dashboard");
  const ml=el.querySelector(".mesi"),on=ml&&ml.querySelector('[aria-pressed="true"]');
  if(on&&ml.scrollWidth>ml.clientWidth)ml.scrollLeft=on.offsetLeft-ml.offsetLeft-(ml.clientWidth-on.offsetWidth)/2;
}
function nessunDato(C){
  return `<div class="card empty"><b>Nessun movimento.</b>Collega il conto ${esc(contoNome(S.conto))} a Banca Valsabbina: i movimenti arriveranno da soli.<br><br><button class="btn" data-act="tab" data-tab="banca">Collega la banca</button>${S.tab==="movimenti"?` <button class="btn ghost" data-act="contanti-nuovo">+ ${nomeExtra()}</button>`:""}</div>`;
}
// Mese/Anno + una casella per ogni anno con movimenti e (in modalità Mese) per ogni mese dell'anno scelto.
function barraPeriodo(conTutto){
  const C=C0(),opts=[["mese","Mese"],["anno","Anno"]];if(conTutto)opts.push(["tutto","Tutto"]);
  let h=`<div class="toolbar periodi"><div class="seg" role="group" aria-label="Periodo">${opts.map(([k,t])=>`<button data-act="per" data-per="${k}" aria-pressed="${S.per===k}">${t}</button>`).join("")}</div>`;
  if(S.per!=="tutto"){
    const anno=S.mese.slice(0,4),y0=+(C.primo||anno).slice(0,4),y1=Math.max(+(C.ultimo||anno).slice(0,4),+anno),anni=[];
    for(let y=Math.min(y0,+anno);y<=y1;y++)anni.push(String(y));
    h+=`<div class="chipline anni" role="group" aria-label="Anno">${anni.map(y=>`<button class="pchip" data-act="anno" data-y="${y}" aria-pressed="${y===anno}">${y}</button>`).join("")}</div>`;
    if(S.per==="mese")h+=`<div class="chipline mesi" role="group" aria-label="Mese">${MESI3.map((m,i)=>{const k=anno+"-"+String(i+1).padStart(2,"0");
      return `<button class="pchip${C.tot[k]?"":" vuoto"}" data-act="mese" data-ym="${k}" aria-pressed="${k===S.mese}" title="${ymNome(k)}${C.tot[k]?"":": nessun movimento"}">${m}</button>`;}).join("")}</div>`;
  }
  return h+"</div>";
}
// Cambiando anno in modalità Mese resta lo stesso mese, se ha movimenti; altrimenti l'ultimo mese con movimenti di quell'anno.
function scegliAnno(y){
  const C=C0();let k=y+S.mese.slice(4);
  if(S.per==="mese"&&!C.tot[k]){const ks=Object.keys(C.tot).filter(x=>x.startsWith(y)).sort();if(ks.length)k=ks[ks.length-1];}
  S.mese=k;S.lim=150;renderMain();
}
/* ---------- panoramica ---------- */
function vPanoramica(C){
  if(!C.mov.length)return nessunDato(C);
  if(S.per==="tutto")S.per="anno";
  const T=totPeriodo(),ms=visibili(),todo=daClassificare(ms).length;
  const quota=T.e>0?Math.round(T.r/T.e*100):null;
  let h=cardSaldi(C)+barraPeriodo(false);
  if(todo)h+=`<div class="banner"><p><b>${todo} ${todo===1?"movimento":"movimenti"} da classificare</b> in questo periodo. Ogni correzione insegna all'app a riconoscerli da sola.</p><button class="btn small" data-act="vai-todo">Classifica ora</button></div>`;
  const PV="polizza-vita",pv=C.mov.some(m=>m._c.id===PV||radice(m._c.id)===PV);
  const pvSomma=ms=>-ms.filter(m=>m._c.id===PV||radice(m._c.id)===PV).reduce((s,m)=>s+m.importo,0);
  const agg={};
  for(const [id,v] of Object.entries(T.net)){const r=radice(id),a=agg[r]??={v:0};a.v+=v;}
  const usc=[];
  for(const [id,a] of Object.entries(agg))if(a.v<-0.004)usc.push([id,-a.v]);
  usc.sort((a,b)=>b[1]-a[1]);
  h+=`<div class="kpis${pv?" k4":""}">
    <div class="kpi"><div class="k"><i class="key in"></i>Entrate</div><div class="v num">${T.e>0.004?"+":""}${eur(T.e)}</div></div>
    <div class="kpi"><div class="k"><i class="key out"></i>Uscite</div><div class="v num">${T.u>0.004?"−":""}${eur(T.u)}</div></div>
    <div class="kpi hero"><div class="k">Risparmio</div><div class="v num">${eurS(T.r)}</div><div class="d">${quota==null?"&nbsp;":quota+"% delle entrate"}</div></div>
    ${pv?`<div class="kpi"><div class="k">Polizza vita</div><div class="v num">${eur(pvSomma(ms))}</div><div class="d">${eur(pvSomma(C.mov))} dall'inizio</div></div>`:""}
  </div>`;
  h+=cardTorta(usc,T.u);
  h+=`<div class="card" style="margin-bottom:14px"><div class="card-head"><h2 class="dotted">${S.per==="anno"?"Mesi del "+S.mese.slice(0,4):"Ultimi 12 mesi"}</h2><div class="legend"><span><i class="key in"></i>Entrate</span><span><i class="key out"></i>Uscite</span></div></div>
    <div class="chart" id="chart-mesi"></div>
    <details class="numbers"><summary>Vedi i numeri</summary>${tabellaMesi(C)}</details></div>`;
  return h;
}
// Una barra per categoria principale. Se ha sottocategorie si apre e mostra il dettaglio.
/* ---------- numeri del conto ---------- */
// Saldo del conto corrente = saldo_base del conto + somma dei movimenti della banca (senza voci scritte a mano).
// saldo_base è il saldo prima del primo movimento salvato: con il collegamento alla banca lo ricalcola la funzione
// "banca" a ogni aggiornamento (saldo_al = giorno del saldo letto dalla banca), così il totale è quello dell'home banking.
const daBanca=m=>m.causale!==CONTANTI&&m.causale!==RETTIFICA&&m.causale!==CARTA; // solo il conto corrente
const contoAttivo=()=>D.conti.find(c=>c.id===S.conto)||{};
const sommaBanca=(C,fino)=>C.mov.filter(m=>daBanca(m)&&(!fino||m.data<=fino)).reduce((s,m)=>s+m.importo,0);
function saldi(C){
  const base=Number(contoAttivo().saldo_base||0),banca=C.mov.filter(daBanca),extra=C.mov.filter(m=>m.causale===CONTANTI);
  const al=banca.reduce((a,m)=>m.data>a?m.data:a,""),sal=contoAttivo().saldo_al;
  return {banca:base+sommaBanca(C),base,al:sal&&sal>al?sal:al,dallaBanca:!!sal,altro:extra.reduce((s,m)=>s+m.importo,0),nAltro:extra.length};
}
function cardSaldi(C){
  const x=saldi(C),nome=nomeExtra(),ca=contoAttivo(),carta=ca.carta_saldo_al!=null;
  const n=1+(S.conto==="comune"?0:1)+(carta?1:0);
  return `<div class="card saldi"><div class="card-head"><h2 class="dotted">Numeri del conto</h2></div>
  <div class="saldigrid${n===1?" uno":n===3?" tre":""}"><div class="saldo" title="${x.dallaBanca?"Saldo comunicato da Banca Valsabbina all'ultimo aggiornamento":"Somma dei movimenti della banca salvati"}"><div class="k">Saldo conto corrente</div><div class="big num">${eur(x.banca)}</div><div class="d">${x.al?"al "+giorno(x.al):"nessun movimento salvato"}</div></div>
  ${carta?`<div class="saldo" title="Saldo della carta prepagata comunicato da NEXI"><div class="k">Saldo prepagata</div><div class="big num">${eur(Number(ca.carta_saldo||0))}</div><div class="d">al ${giorno(ca.carta_saldo_al)}</div></div>`:""}
  ${S.conto==="comune"?"":`<div class="saldo"><div class="k">Saldo ${nome}</div><div class="big num">${eurS(x.altro)}</div></div>`}</div></div>`;
}
/* ---------- ciambella delle uscite ---------- */
// Colori fissi per categoria, in ordine di uscite in tutto lo storico del conto: le prime 8 hanno gli 8 colori verificati
// per daltonismo (--s1..--s8), le successive 8 le tinte più tenui degli stessi colori (--s9..--s16), poi grigio.
// Così un colore indica sempre la stessa categoria, in qualunque mese o anno.
function coloriTorta(){
  const C=C0(),tot={};
  for(const m of C.mov){const c=C.byId[m._c.id];if(!c||c.tipo!=="normale"||m._c.id===SALDO)continue;const r=radice(m._c.id);tot[r]=(tot[r]||0)+m.importo;}
  const ord=Object.entries(tot).filter(([id,v])=>v<0&&C.byId[id]?.verso!=="entrata").sort((a,b)=>a[1]-b[1]);
  return Object.fromEntries(ord.map(([id],i)=>[id,i+1]));
}
function cardTorta(usc,tot){
  if(!usc.length||tot<=0.004)return "";
  const col=coloriTorta(),top=usc.map(([id,v])=>({id,v,nome:nomeCat(id)}));
  const fill=x=>col[x.id]&&col[x.id]<=16?`var(--s${col[x.id]})`:"var(--s-altro)";
  const R=100,r=64,cx=110,cy=110,pt=(a,rr)=>`${(cx+rr*Math.sin(a)).toFixed(2)} ${(cy-rr*Math.cos(a)).toFixed(2)}`;
  let a0=0,svg="";
  top.forEach((x,i)=>{
    const a1=a0+x.v/tot*2*Math.PI,big=a1-a0>Math.PI?1:0;
    const d=a1-a0>=2*Math.PI-1e-6?`M${pt(0,R)}A${R} ${R} 0 1 1 ${pt(Math.PI,R)}A${R} ${R} 0 1 1 ${pt(0,R)}M${pt(0,r)}A${r} ${r} 0 1 0 ${pt(Math.PI,r)}A${r} ${r} 0 1 0 ${pt(0,r)}Z`
      :`M${pt(a0,R)}A${R} ${R} 0 ${big} 1 ${pt(a1,R)}L${pt(a1,r)}A${r} ${r} 0 ${big} 0 ${pt(a0,r)}Z`;
    svg+=`<path d="${d}" style="fill:${fill(x)}" fill-rule="evenodd" class="fetta" data-act="vai-cat" data-cat="${esc(x.id)}" data-tip="${i}"/>`;
    a0=a1;
  });
  const leg=top.map((x,i)=>{const q=x.v/tot*100,pc=q<1?"<1":Math.round(q);
    const corpo=`<i class="sw" style="background:${fill(x)}"></i><span class="n">${esc(x.nome)}</span><span class="a num">${eur(x.v)}</span><span class="p num">${pc}%</span>`;
    return `<button class="dleg" data-act="vai-cat" data-cat="${esc(x.id)}" data-tip="${i}">${corpo}</button>`;}).join("");
  cardTorta.dati=top.map(x=>({...x,pc:x.v/tot*100,colore:fill(x)}));
  return `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Dove vanno le uscite</h2><p class="meta">tocca una categoria per vedere i movimenti</p></div>
  <div class="donutwrap"><div class="donut" id="donut"><svg viewBox="0 0 220 220" role="img" aria-label="Uscite per categoria">${svg}
    <text x="110" y="106" text-anchor="middle" class="dtot num">${eur(tot)}</text><text x="110" y="128" text-anchor="middle" class="dlab">uscite</text></svg></div>
  <div class="dlegend">${leg}</div></div></div>`;
}
function tipTorta(){
  const el=$("donut")?.closest(".donutwrap");if(!el)return;
  el.onmousemove=e=>{const t=e.target.closest("[data-tip]"),x=t&&cardTorta.dati?.[+t.dataset.tip];if(!x){nascondiTip();return;}
    mostraTip(e,`<b>${esc(x.nome)}</b><div><span><i class="key" style="background:${x.colore}"></i>Uscite</span><span class="num">${eur(x.v)}</span></div><div><span>Quota</span><span class="num">${x.pc.toFixed(1).replace(".",",")}%</span></div>`);};
  el.onmouseleave=nascondiTip;
}
function mesiGrafico(){return S.per==="anno"?mesiTra(S.mese.slice(0,4)+"-01",S.mese.slice(0,4)+"-12"):mesiTra(ymAdd(S.mese,-11),S.mese);}
function tabellaMesi(C){
  const rows=mesiGrafico().filter(k=>C.tot[k]).reverse();
  return `<table class="t num"><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Risparmio</th></tr></thead><tbody>${rows.map(k=>{const t=C.tot[k];return `<tr><td>${ymNome(k)}</td><td>${eur(t.e)}</td><td>${eur(t.u)}</td><td>${eurS(t.r)}</td></tr>`;}).join("")}</tbody></table>`;
}
// Colonne raggruppate entrate/uscite: barre ≤24px, angoli arrotondati solo in cima, 2px tra le due barre.
function disegnaGrafici(){
  const el=$("chart-mesi");if(!el)return;
  const C=C0(),mesi=mesiGrafico(),W=Math.max(280,el.clientWidth),H=210,pl=44,pb=26,pt=8,ih=H-pb-pt;
  const vals=mesi.map(k=>C.tot[k]||{e:0,u:0,r:0});
  let max=Math.max(1,...vals.map(v=>Math.max(v.e,v.u)));
  const passo=Math.pow(10,Math.floor(Math.log10(max/4)));const st=[1,2,2.5,5,10].map(x=>x*passo).find(x=>x*4>=max)||passo*10;max=st*4;
  const bw=(W-pl)/mesi.length,bar=Math.max(4,Math.min(24,(bw-10)/2)),y=v=>pt+ih-(v/max)*ih;
  const col=(x,v,cls)=>{if(v<=0)return "";const h=Math.max(1,(v/max)*ih),r=Math.min(4,h),y0=pt+ih-h;
    return `<path class="${cls}" d="M${x},${pt+ih}V${y0+r}Q${x},${y0} ${x+r},${y0}H${x+bar-r}Q${x+bar},${y0} ${x+bar},${y0+r}V${pt+ih}Z"/>`;};
  const ogni=bw<30?2:1;
  let s=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Entrate e uscite per mese">`;
  for(let i=0;i<=4;i++){const v=st*i,yy=y(v);s+=`<line class="${i?"gl":"base"}" x1="${pl}" x2="${W}" y1="${yy}" y2="${yy}"/><text class="tick num" x="${pl-8}" y="${yy+4}" text-anchor="end">${compatto(v)}</text>`;}
  mesi.forEach((k,i)=>{const x0=pl+i*bw,cx=x0+bw/2,sel=S.per==="mese"&&k===S.mese;
    if(sel)s+=`<rect class="selbg" x="${x0+2}" y="${pt}" width="${bw-4}" height="${ih}" rx="6"/>`;
    s+=col(cx-bar-1,vals[i].e,"bin")+col(cx+1,vals[i].u,"bout");
    if(i%ogni===(mesi.length-1)%ogni)s+=`<text class="tick${sel?" sel":""}" x="${cx}" y="${H-8}" text-anchor="middle">${MESI3[+k.slice(5)-1]}${k.endsWith("-01")&&S.per==="mese"?" "+k.slice(2,4):""}</text>`;
    s+=`<rect class="hit" x="${x0}" y="${pt}" width="${bw}" height="${ih+pb}" data-act="mese" data-ym="${k}" data-tip="${i}"/>`;});
  el.innerHTML=s+"</svg>";
  el.onmousemove=e=>{const r=e.target.closest("[data-tip]");if(!r){nascondiTip();return;}const k=mesi[+r.dataset.tip],v=vals[+r.dataset.tip];
    mostraTip(e,`<b>${ymNome(k)}</b><div><span><i class="key in"></i>Entrate</span><span class="num">${eur(v.e)}</span></div><div><span><i class="key out"></i>Uscite</span><span class="num">${eur(v.u)}</span></div><div><span>Risparmio</span><span class="num">${eurS(v.r)}</span></div>`);};
  el.onmouseleave=nascondiTip;
}
function mostraTip(e,html){const t=$("tip");t.innerHTML=html;t.hidden=false;const w=t.offsetWidth,h=t.offsetHeight;
  let x=e.clientX+14,y=e.clientY-h-10;if(x+w>innerWidth-8)x=e.clientX-w-14;if(y<8)y=e.clientY+16;t.style.left=x+"px";t.style.top=y+"px";}
function nascondiTip(){$("tip").hidden=true;}

/* ---------- movimenti ---------- */
function vMovimenti(C){
  if(!C.mov.length)return nessunDato(C);
  const nf=nFiltri(S.filtri);
  return barraPeriodo(true)+`<div class="filters"><input class="input" type="search" id="q" data-input="q" placeholder="Cerca esercente, descrizione, nota, importo…" value="${esc(S.q)}" aria-label="Cerca"></div>
    <div class="mbar"><div class="seg" role="group" aria-label="Entrate o uscite">${[["tutti","Entrambe"],["entrate","Entrate"],["uscite","Uscite"]].map(([k,t])=>`<button data-act="verso" data-v="${k}" aria-pressed="${S.verso===k}">${t}</button>`).join("")}</div>
    <span class="mbtns"><button class="btn" data-act="contanti-nuovo">+ ${nomeExtra()}</button><button class="btn ghost filtribtn" data-act="filtri">Filtri${nf?`<span class="badge">${nf}</span>`:""}</button></span></div>
    <div id="attivi"></div><div id="mres"></div>`;
}
const nFiltri=f=>f.cats.length+(f.min!==""?1:0)+(f.max!==""?1:0)+(f.nota?1:0)+(f.manuale?1:0);
// Applica entrate/uscite, filtri e ricerca. f = filtri da usare (di default quelli attivi; la finestra Filtri passa i suoi per il conteggio).
function filtrati(f=S.filtri){
  let ms=visibili();
  if(S.verso==="entrate")ms=ms.filter(m=>m.importo>0); else if(S.verso==="uscite")ms=ms.filter(m=>m.importo<0);
  if(f.cats.length){const set=new Set(f.cats.flatMap(id=>[id,...figli(id).map(c=>c.id)]));ms=ms.filter(m=>set.has(m._c.id));}
  const mn=L.numero(f.min),mx=L.numero(f.max);
  if(mn!=null)ms=ms.filter(m=>Math.abs(m.importo)>=mn);
  if(mx!=null)ms=ms.filter(m=>Math.abs(m.importo)<=mx);
  if(f.nota)ms=ms.filter(m=>m.nota);
  if(f.manuale)ms=ms.filter(m=>m._c.come==="manuale");
  const q=L.norm(S.q);
  if(q){const n=q.replace(/\./g,"").replace(",",".");
    ms=ms.filter(m=>L.norm(m.descrizione+" "+m._e+" "+(m.nota||"")+" "+nomeCat(m._c.id)).includes(q)||(/^[\d.,]+$/.test(q)&&Math.abs(m.importo).toFixed(2).includes(n)));}
  return ms;
}
// Filtri attivi come pillole: un tocco li toglie.
function renderAttivi(){
  const el=$("attivi");if(!el)return;const f=S.filtri,p=[];
  f.cats.forEach(id=>p.push(["cat:"+id,nomeCat(id)]));
  if(f.min!=="")p.push(["min","da "+eur(L.numero(f.min)||0)]);
  if(f.max!=="")p.push(["max","fino a "+eur(L.numero(f.max)||0)]);
  if(f.nota)p.push(["nota","con nota"]);
  if(f.manuale)p.push(["manuale","categoria scelta a mano"]);
  el.innerHTML=p.length?`<div class="chips attivi">${p.map(([k,t])=>`<button class="chip" aria-pressed="true" data-act="togli-filtro" data-k="${esc(k)}" aria-label="Togli il filtro ${esc(t)}">${esc(t)} <span aria-hidden="true">×</span></button>`).join("")}<button class="linkbtn" data-act="azzera-filtri">Azzera</button></div>`:"";
}
function sheetFiltri(){
  const C=C0(),f=sheet.f,set=new Set(f.cats),n=filtrati(f).length;
  const gr=[["Uscite",c=>c.tipo==="normale"&&c.verso==="uscita"],["Entrate",c=>c.tipo==="normale"&&c.verso==="entrata"],["Giroconti, investimenti e saldo iniziale",c=>c.tipo!=="normale"]];
  const tog=(k,t)=>`<button class="chip" data-act="f-tog" data-k="${k}" aria-pressed="${!!f[k]}">${t}</button>`;
  return `<div class="sh-head"><div><div class="eyebrow">Movimenti · ${S.per==="tutto"?"tutti i periodi":S.per==="anno"?S.mese.slice(0,4):ymNome(S.mese)}</div><h2>Filtri</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <div class="sec" style="border-top:0;margin-top:0;padding-top:0"><h3>Categorie</h3><p class="hint">Tocca una o più categorie. Nessuna selezionata = tutte.</p>
  ${gr.map(([t,fn])=>{const cs=C.cats.filter(fn);return cs.length?`<p class="hint" style="margin:10px 0 6px">${t}</p>${chipsAlbero(cs,(c,sub)=>`<button class="chip${sub?" sub":""}" data-act="f-cat" data-cat="${esc(c.id)}" aria-pressed="${set.has(c.id)}">${esc(c.nome)}</button>`)}`:"";}).join("")}</div>
  <div class="sec"><h3>Importo</h3><div style="display:flex;gap:10px"><label class="field" style="flex:1"><span>Da (€)</span><input data-filtro="min" inputmode="decimal" value="${esc(f.min)}" placeholder="0"></label><label class="field" style="flex:1"><span>A (€)</span><input data-filtro="max" inputmode="decimal" value="${esc(f.max)}" placeholder="nessun limite"></label></div><p class="hint" style="margin-top:6px">Vale per entrate e uscite (importo senza segno).</p></div>
  <div class="sec"><h3>Altro</h3><div class="chips">${tog("nota","Con nota")}${tog("manuale","Categoria scelta a mano")}</div></div>
  <div class="sh-foot"><button class="btn ghost" data-act="f-azzera">Azzera</button><span class="grow"></span><button class="btn" data-act="f-applica" id="f-applica">Mostra ${n} ${n===1?"movimento":"movimenti"}</button></div>`;
}
function renderLista(){
  renderAttivi();
  const el=$("mres");if(!el)return;
  const ms=filtrati(),C=C0();
  if(!ms.length){el.innerHTML=`<div class="card empty"><b>Nessun movimento.</b>Prova a cambiare periodo, filtri o ricerca.</div>`;return;}
  let h="";
  const vis=ms.slice(0,S.lim),gr={};
  for(const m of vis)(gr[m.data.slice(0,7)]??=[]).push(m);
  for(const k of Object.keys(gr).sort().reverse()){
    const tk=ms.filter(m=>m.data.startsWith(k)).reduce((s,m)=>s+m.importo,0);
    h+=`<div class="mgroup"><h3>${ymNome(k)} <span class="num">${eurS(tk)}</span></h3><div class="mlist">${gr[k].map(m=>rigaMov(m,C)).join("")}</div></div>`;
  }
  if(ms.length>S.lim)h+=`<div class="more"><button class="btn ghost" data-act="altri">Mostra altri ${Math.min(150,ms.length-S.lim)}</button></div>`;
  el.innerHTML=h;
}
function rigaMov(m,C){
  const [,mm,dd]=m.data.split("-"),c=m._c,todo=c.id==="da-classificare";
  return `<button class="mov" data-act="mov" data-id="${m.id}"><span class="dt"><b>${+dd}</b>${MESI3[+mm-1]}</span>
    <span style="min-width:0"><span class="who" style="display:block">${esc(m._e)}</span><span class="sub">${m.causale===CONTANTI?`<span class="pill cash">${nomeExtra().toLowerCase()}</span>`:m.causale===RETTIFICA?`<span class="pill">rettifica</span>`:m.causale===CARTA?`<span class="pill cash">prepagata</span>`:""}<span class="pill${todo?" todo":""}${c.come==="manuale"?" manual":""}">${esc(nomeCat(c.id))}</span>${m.nota?`<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.nota)}</span>`:""}</span></span>
    <span class="amt num${m.importo>0?" pos":""}">${eurS(m.importo)}</span></button>`;
}
function chipsCategorie(C,sel){
  const gr=[["Uscite",c=>c.tipo==="normale"&&c.verso==="uscita"],["Entrate",c=>c.tipo==="normale"&&c.verso==="entrata"],["Giroconti, investimenti e saldo iniziale",c=>c.tipo!=="normale"]];
  return gr.map(([t,f])=>{const cs=C.cats.filter(f);return cs.length?`<p class="hint" style="margin:8px 0 6px">${t}</p>${chipsAlbero(cs,(c,sub)=>`<button class="chip${sub?" sub":""}" data-act="scegli-cat" data-cat="${esc(c.id)}" aria-pressed="${sel===c.id}">${esc(c.nome)}</button>`)}`:"";}).join("");
}
function apriMov(id){
  const C=C0(),m=C.mov.find(x=>x.id===+id);if(!m)return;
  if(m.causale===CONTANTI){sheet={tipo:"contanti",id:m.id,f:{verso:m.importo<0?"uscita":"entrata",importo:String(Math.abs(m.importo)).replace(".",","),data:m.data,descr:m.descrizione,cat:m.categoria||""}};renderSheet();return;}
  sheet={tipo:"mov",id:m.id,sel:m._c.id,regola:m._c.come!=="manuale",testo:m._c.regola||L.testoRegola(m),nota:m.nota||""};
  renderSheet();
}
function contaTesto(t){const C=C0(),n=L.norm(t);return n?C.mov.filter(m=>L.norm(m.descrizione).includes(n)).length:0;}
function sheetMov(){
  const C=C0(),m=C.mov.find(x=>x.id===sheet.id);if(!m){chiudi();return "";}
  const imp=C.imps.find(i=>i.id===m.importazione);
  const n=contaTesto(sheet.testo);
  return `<div class="sh-head"><div><div class="eyebrow">${giorno(m.data)} · ${esc(CAUSALI[m.causale]||"Causale "+m.causale)}</div><h2>${esc(m._e)}</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <div class="num${m.importo>0?" pos":""}" style="font-size:26px;font-weight:600">${eurS(m.importo)}</div>
  <p class="desc">${esc(m.descrizione)}</p>
  <div class="facts"><div><span>Data contabile</span> ${giorno(m.data)}</div>${m.valuta?`<div><span>Valuta</span> ${giorno(m.valuta)}</div>`:""}<div><span>Causale</span> ${esc(m.causale)}</div>${imp?`<div><span>Importato da</span> ${esc(imp.nome_file||"XLS")}</div>`:""}</div>
  <div class="sec"><h3>Categoria</h3><p class="hint">${esc(COME[m._c.come])}${m._c.regola?` «${esc(m._c.regola)}»`:""}</p>${chipsCategorie(C,sheet.sel)}
    <label class="check"><input type="checkbox" data-sheet="regola" ${sheet.regola?"checked":""}><span>Usa questa categoria anche per tutti gli altri movimenti, presenti e futuri, che contengono:</span></label>
    <div class="rulebox" ${sheet.regola?"":"hidden"}><input class="input" data-sheet="testo" value="${esc(sheet.testo)}" aria-label="Testo da riconoscere"><p class="hint" id="conta-testo">${nMov(n," di questo conto")}</p></div></div>
  <div class="sec"><h3>Nota</h3><textarea class="input" rows="2" data-sheet="nota" placeholder="Es. regalo per la mamma">${esc(sheet.nota)}</textarea></div>
  <div class="sh-foot">${m.categoria?`<button class="btn ghost" data-act="mov-auto">Torna automatica</button>`:""}<span class="grow"></span><button class="btn ghost" data-act="chiudi">Annulla</button><button class="btn" data-act="mov-salva">Salva</button></div>`;
}
async function salvaMov(){
  const C=C0(),m=C.mov.find(x=>x.id===sheet.id);if(!m)return;
  const sel=sheet.sel,testo=L.norm(sheet.testo);
  if(sheet.nota!==(m.nota||"")){const {error}=await sb.from("movimenti").update({nota:sheet.nota||null}).eq("id",m.id);if(error)return errore(error);m.nota=sheet.nota||null;}
  let msg="Salvato.";
  if(sheet.regola&&testo){
    if(!L.norm(m.descrizione).includes(testo)){toast("Il testo della regola non compare in questo movimento: correggilo.");return;}
    const {data,error}=await sb.from("regole").upsert({conto:S.conto,testo,categoria:sel},{onConflict:"conto,testo"}).select().single();
    if(error)return errore(error);
    C.regole=C.regole.filter(r=>r.testo!==testo).concat(data);
    if(m.categoria){await sb.from("movimenti").update({categoria:null}).eq("id",m.id);m.categoria=null;}
    prepara(S.conto);
    if(m._c.id!==sel){await sb.from("movimenti").update({categoria:sel}).eq("id",m.id);m.categoria=sel;prepara(S.conto);} // una regola più specifica vince: allora scelta a mano
    const n=C.mov.filter(x=>x._c.regola===testo).length;
    msg=`Regola salvata: ${n} ${n===1?"movimento":"movimenti"} in «${nomeCat(sel)}».`;
  }else if(sel!==m._c.id||m.categoria!==sel){
    const {error}=await sb.from("movimenti").update({categoria:sel}).eq("id",m.id);if(error)return errore(error);
    m.categoria=sel;prepara(S.conto);msg=`Categoria cambiata solo per questo movimento.`;
  }
  chiudi();renderAll();toast(msg);
}
async function movAuto(){
  const C=C0(),m=C.mov.find(x=>x.id===sheet.id);if(!m)return;
  const {error}=await sb.from("movimenti").update({categoria:null}).eq("id",m.id);if(error)return errore(error);
  m.categoria=null;prepara(S.conto);chiudi();renderAll();toast("Ora la categoria la decidono le regole.");
}

/* ---------- movimenti fuori banca ("Altro" / "Rifle") ---------- */
// Entrate e uscite che non passano dalla banca, scritte a mano: stanno nel conto come gli altri movimenti, con causale CONTANTI.
const oggiISO=()=>{const t=new Date();return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0");};
function sheetContanti(){
  const C=C0(),f=sheet.f,cs=C.cats.filter(c=>c.tipo==="normale"&&c.verso===f.verso);
  const conf=sheet.id&&S.conferma["cash"+sheet.id]&&Date.now()-S.conferma["cash"+sheet.id]<4000;
  return `<div class="sh-head"><div><div class="eyebrow">${nomeExtra()} · conto ${esc(contoNome(S.conto))} · fuori banca</div><h2>${sheet.id?"Modifica movimento":"Nuovo movimento"}</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <div style="display:flex;flex-direction:column;gap:12px">
  <div class="seg" role="group" aria-label="Entrata o uscita">${[["uscita","Uscita"],["entrata","Entrata"]].map(([v,t])=>`<button data-act="c-verso" data-v="${v}" aria-pressed="${f.verso===v}">${t}</button>`).join("")}</div>
  <div style="display:flex;gap:10px;flex-wrap:wrap"><label class="field" style="flex:1 1 140px"><span>Importo (€)</span><input data-sheet="importo" inputmode="decimal" value="${esc(f.importo)}" placeholder="0,00"></label>
  <label class="field" style="flex:1 1 140px"><span>Data</span><input type="date" data-sheet="data" value="${esc(f.data)}" max="${oggiISO()}"></label></div>
  <label class="field"><span>Descrizione</span><input data-sheet="descr" value="${esc(f.descr)}" maxlength="80" placeholder="${f.verso==="uscita"?"Es. spesa pagata in contanti":S.conto==="anna"?"Es. seduta di riflessologia":"Es. regalo, rimborso di un amico"}"></label></div>
  <div class="sec"><h3>Categoria</h3><p class="hint" style="margin-bottom:6px">Facoltativa: se non la scegli, l'app prova a riconoscerla dalla descrizione.</p>
  ${chipsAlbero(cs,(c,sub)=>`<button class="chip${sub?" sub":""}" data-act="c-cat" data-cat="${esc(c.id)}" aria-pressed="${f.cat===c.id}">${esc(c.nome)}</button>`)}</div>
  <div class="sh-foot">${sheet.id?`<button class="btn ${conf?"danger":"ghost"}" data-act="c-elimina">${conf?"Tocca di nuovo per eliminare":"Elimina"}</button>`:""}<span class="grow"></span><button class="btn ghost" data-act="chiudi">Annulla</button><button class="btn" data-act="c-salva">Salva</button></div>`;
}
// Scheda "Altro" / "Rifle": tutti i movimenti inseriti con il pulsante + Altro / + Rifle (causale CONTANTI).
// Le rettifiche (causale RETTIFICA, es. polizza pagata dal vecchio conto) stanno nel conto ma non qui.
function vAltro(C){
  const nome=nomeExtra(),tutti=C.mov.filter(m=>m.causale===CONTANTI);
  const p=S.per==="tutto"?"":S.per==="anno"?S.mese.slice(0,4):S.mese,ms=tutti.filter(m=>m.data.startsWith(p));
  const ent=ms.filter(m=>m.importo>0).reduce((s,m)=>s+m.importo,0),usc=-ms.filter(m=>m.importo<0).reduce((s,m)=>s+m.importo,0);
  let h=barraPeriodo(true)+`<div class="toolbar"><p class="meta grow">Entrate e uscite fuori banca scritte a mano nel conto ${esc(contoNome(S.conto))}: ${tutti.length} in tutto.</p><button class="btn" data-act="contanti-nuovo">+ ${nome}</button></div>`;
  if(!ms.length)return h+`<div class="card empty"><b>Nessun movimento.</b>${tutti.length?"In questo periodo non ce ne sono: prova «Tutto».":`Con «+ ${nome}» aggiungi entrate e uscite che non passano dalla banca.`}</div>`;
  h+=`<div class="kpis"><div class="kpi"><div class="k"><i class="key in"></i>Entrate</div><div class="v num">${ent>0.004?"+":""}${eur(ent)}</div></div>
    <div class="kpi"><div class="k"><i class="key out"></i>Uscite</div><div class="v num">${usc>0.004?"−":""}${eur(usc)}</div></div>
    <div class="kpi hero"><div class="k">Saldo ${nome}</div><div class="v num">${eurS(ent-usc)}</div><div class="d">${ms.length} ${ms.length===1?"movimento":"movimenti"}</div></div></div>`;
  const gr={};for(const m of ms)(gr[m.data.slice(0,7)]??=[]).push(m);
  for(const k of Object.keys(gr).sort().reverse()){
    const tk=gr[k].reduce((s,m)=>s+m.importo,0);
    h+=`<div class="mgroup"><h3>${ymNome(k)} <span class="num">${eurS(tk)}</span></h3><div class="mlist">${gr[k].map(m=>rigaMov(m,C)).join("")}</div></div>`;
  }
  return h+`<p class="hint" style="margin-top:12px">Qui compare tutto ciò che è stato inserito con «+ ${nome}». Le rettifiche (es. polizza vita pagata dal vecchio conto) restano nel conto ma non in questa pagina.</p>`;
}
const ordinaMov=C=>C.mov.sort((a,b)=>a.data<b.data?1:a.data>b.data?-1:a.id-b.id);
async function salvaContanti(){
  const C=C0(),f=sheet.f,v=L.numero(f.importo),era=sheet.id;
  if(!v||v<=0){toast("Scrivi un importo valido.");return;}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(f.data||"")){toast("Scegli la data.");return;}
  const row={data:f.data,valuta:f.data,importo:Math.round((f.verso==="uscita"?-v:v)*100)/100,causale:CONTANTI,descrizione:f.descr.trim()||nomeExtra(),categoria:f.cat||null};
  let r;
  if(sheet.id)r=await sb.from("movimenti").update(row).eq("id",sheet.id).select("id,data,valuta,importo,causale,descrizione,chiave,categoria,nota,importazione").single();
  else r=await sb.from("movimenti").insert({...row,conto:S.conto,chiave:CONTANTI+"|"+Date.now()+"|"+Math.random().toString(36).slice(2,8)}).select("id,data,valuta,importo,causale,descrizione,chiave,categoria,nota,importazione").single();
  if(r.error)return errore(r.error);
  const m={...r.data,importo:Number(r.data.importo)};
  C.mov=C.mov.filter(x=>x.id!==m.id).concat(m);ordinaMov(C);prepara(S.conto);
  chiudi();renderAll();toast(`${era?"Modificato":"Aggiunto"} in ${nomeExtra()}: ${eurS(m.importo)}, ${giorno(m.data)}.`);
}
async function eliminaContanti(){
  const k="cash"+sheet.id;
  if(!(S.conferma[k]&&Date.now()-S.conferma[k]<4000)){S.conferma[k]=Date.now();renderSheet();return;}
  const C=C0(),{error}=await sb.from("movimenti").delete().eq("id",sheet.id);if(error)return errore(error);
  C.mov=C.mov.filter(m=>m.id!==sheet.id);prepara(S.conto);chiudi();renderAll();toast(`Movimento di ${nomeExtra()} eliminato.`);
}

/* ---------- categorie e regole ---------- */
function vCategorie(C){
  const anno=S.mese.slice(0,4),ms=C.mov.filter(m=>m.data.startsWith(anno)),stat={};
  for(const m of ms)for(const id of new Set([m._c.id,radice(m._c.id)])){const s=stat[id]??={n:0,t:0};s.n++;s.t+=m.importo;}
  const usate={};for(const r of C.regole)usate[r.testo]=C.mov.filter(m=>m._c.regola===r.testo).length;
  const tipoTag=c=>c.id===SALDO?"saldo iniziale":c.tipo==="trasferimento"?"giroconto":c.tipo==="investimento"?"investimento":c.verso;
  const gr=[["Uscite",c=>c.tipo==="normale"&&c.verso==="uscita"],["Entrate",c=>c.tipo==="normale"&&c.verso==="entrata"],["Giroconti, investimenti e saldo iniziale",c=>c.tipo!=="normale"]];
  const todo=daClassificare(C.mov).length;
  let h=`<div class="toolbar"><p class="meta grow">Numeri del ${anno}. Le categorie valgono solo per il conto ${esc(contoNome(S.conto))}.</p><button class="btn" data-act="cat-nuova">Nuova categoria</button></div>`;
  if(todo)h+=`<div class="banner"><p><b>${todo} da classificare</b> in tutto il conto.</p><button class="btn small" data-act="vai-todo-tutti">Classifica ora</button></div>`;
  h+=`<div class="grid g2"><div class="card">${gr.map(([t,f])=>{const cs=C.cats.filter(f);return cs.length?`<h3 style="margin:6px 0 4px">${t}</h3><div class="clist">${cs.map(c=>{const s=stat[c.id]||{n:0,t:0};
    return `<div class="crow${c.padre?" sub":""}"><div><span class="n">${esc(c.nome)}</span>${c.tipo!=="normale"?`<span class="tag">${tipoTag(c)}</span>`:""}<div class="s num">${s.n} mov. · ${eurS(s.t)}</div></div>
    <button class="btn ghost small" data-act="vai-cat-tutto" data-cat="${esc(c.id)}">Vedi</button><button class="btn ghost small" data-act="cat-mod" data-cat="${esc(c.id)}">Modifica</button></div>`;}).join("")}</div>`:"";}).join("")}</div>
  <div class="card"><div class="card-head"><h2 class="dotted">Regole imparate</h2><p class="meta">${C.regole.length} regole</p></div>
  ${C.regole.length?`<div class="clist">${C.regole.slice().sort((a,b)=>a.testo.localeCompare(b.testo,"it")).map(r=>`<div class="crow"><div><span class="n">«${esc(r.testo)}»</span><div class="s">→ ${esc(nomeCat(r.categoria))} · ${usate[r.testo]} mov.</div></div><span></span><button class="btn ghost small" data-act="reg-mod" data-id="${r.id}">Modifica</button></div>`).join("")}</div>`
  :`<p class="meta">Ancora nessuna. Quando correggi la categoria di un movimento puoi dire all'app di ricordarla: nasce una regola, che vale anche per i prossimi movimenti.</p>`}
  <div class="sec"><h3>Come sceglie la categoria</h3><ol class="hint" style="padding-left:18px;margin:0;display:flex;flex-direction:column;gap:3px"><li>La scelta fatta a mano su quel movimento.</li><li>Le regole imparate (se più regole valgono, vince la più lunga).</li><li>Il codice causale della banca (commissioni, bollo, F24, prelievi…).</li><li>Un elenco di esercenti italiani (supermercati, utenze, carburante…).</li><li>Altrimenti «Da classificare» (uscite) o «Altre entrate».</li></ol></div></div></div>`;
  return h;
}
function sheetCat(){
  const C=C0(),c=sheet.id?C.byId[sheet.id]:null,f=sheet.f;
  const prot=c&&PROTETTE.includes(c.id),n=c?C.mov.filter(m=>m._c.id===c.id).length:0;
  const seg=(k,opts)=>`<div class="seg" role="group">${opts.map(([v,t])=>`<button data-act="cat-f" data-k="${k}" data-v="${v}" aria-pressed="${f[k]===v}">${t}</button>`).join("")}</div>`;
  const conf=S.conferma["cat"+sheet.id]&&Date.now()-S.conferma["cat"+sheet.id]<4000;
  const haFigli=c&&C.cats.some(x=>x.padre===c.id),padri=padriPossibili(f);
  return `<div class="sh-head"><div><div class="eyebrow">${c?"Modifica categoria":"Nuova categoria"}</div><h2>${esc(f.nome||"Senza nome")}</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <label class="field"><span>Nome</span><input data-sheet="nome" value="${esc(f.nome)}" maxlength="40" placeholder="Es. Animali"></label>
  <div class="sec"><h3>Tipo</h3>${seg("tipo",[["normale","Entrata o uscita"],["trasferimento","Giroconto"],["investimento","Investimento"]])}
  <p class="hint" style="margin-top:8px">${f.tipo==="trasferimento"?"Soldi spostati tra conti vostri: non contano né come entrate né come uscite.":f.tipo==="investimento"?"Soldi investiti (broker, PAC, fondo pensione): non sono spese e contano per gli obiettivi di investimento.":"Conta nelle entrate o nelle uscite del conto."}</p>
  ${f.tipo==="normale"?`<div style="margin-top:8px">${seg("verso",[["uscita","Uscita"],["entrata","Entrata"]])}</div>`:""}</div>
  <div class="sec"><h3>Sottocategoria</h3>${haFigli?`<p class="hint">Ha delle sottocategorie, quindi resta una categoria principale.</p>`:`<label class="field"><span>Dentro a</span><select class="input" data-sheet="padre"><option value="">Nessuna: è una categoria principale</option>${padri.map(p=>`<option value="${esc(p.id)}"${f.padre===p.id?" selected":""}>${esc(p.nome)}</option>`).join("")}</select></label><p class="hint" style="margin-top:6px">Le sottocategorie si sommano alla loro categoria principale in panoramica.</p>`}</div>
  <div class="sh-foot">${c&&!prot?`<button class="btn ${conf?"danger":"ghost"}" data-act="cat-elimina">${conf?"Tocca di nuovo per eliminare":"Elimina"}</button>`:""}<span class="grow"></span><button class="btn ghost" data-act="chiudi">Annulla</button><button class="btn" data-act="cat-salva">Salva</button></div>
  ${c&&!prot&&n?`<p class="hint" style="margin-top:8px">Se la elimini, i suoi ${n} movimenti tornano a essere classificati in automatico e le sue regole vengono cancellate.${haFigli?" Le sue sottocategorie diventano categorie principali.":""}</p>`:""}`;
}
// Una categoria può stare dentro a una principale dello stesso tipo (non dentro a se stessa né a una sottocategoria).
const padriPossibili=f=>C0().cats.filter(x=>!x.padre&&x.id!==sheet.id&&x.tipo===f.tipo&&(f.tipo!=="normale"||x.verso===f.verso));
async function salvaCat(){
  const C=C0(),f=sheet.f,nome=f.nome.trim();if(!nome){toast("Scrivi un nome.");return;}
  const padre=f.padre&&padriPossibili(f).some(p=>p.id===f.padre)&&!(sheet.id&&C.cats.some(x=>x.padre===sheet.id))?f.padre:null;
  if(sheet.id){
    const {error}=await sb.from("categorie").update({nome,tipo:f.tipo,verso:f.verso,padre}).eq("conto",S.conto).eq("id",sheet.id);if(error)return errore(error);
    Object.assign(C.byId[sheet.id],{nome,tipo:f.tipo,verso:f.verso,padre});
  }else{
    let id=nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"cat";
    while(C.byId[id])id+="-2";
    const row={conto:S.conto,id,nome,tipo:f.tipo,verso:f.verso,padre,ordine:Math.max(0,...C.cats.map(c=>c.ordine))+1};
    const {error}=await sb.from("categorie").insert(row);if(error)return errore(error);
    C.cats.push(row);
  }
  prepara(S.conto);chiudi();renderAll();toast("Categoria salvata.");
}
async function eliminaCat(){
  const k="cat"+sheet.id;
  if(!(S.conferma[k]&&Date.now()-S.conferma[k]<4000)){S.conferma[k]=Date.now();renderSheet();return;}
  const C=C0(),id=sheet.id;
  let r=await sb.from("categorie").update({padre:null}).eq("conto",S.conto).eq("padre",id);if(r.error)return errore(r.error);
  r=await sb.from("movimenti").update({categoria:null}).eq("conto",S.conto).eq("categoria",id);if(r.error)return errore(r.error);
  r=await sb.from("regole").delete().eq("conto",S.conto).eq("categoria",id);if(r.error)return errore(r.error);
  r=await sb.from("categorie").delete().eq("conto",S.conto).eq("id",id);if(r.error)return errore(r.error);
  C.cats=C.cats.filter(c=>c.id!==id);C.cats.forEach(c=>{if(c.padre===id)c.padre=null;});C.regole=C.regole.filter(x=>x.categoria!==id);C.mov.forEach(m=>{if(m.categoria===id)m.categoria=null;});
  prepara(S.conto);chiudi();renderAll();toast("Categoria eliminata.");
}
function sheetReg(){
  const C=C0(),r=C.regole.find(x=>x.id===sheet.id);if(!r){chiudi();return "";}
  const conf=S.conferma["reg"+r.id]&&Date.now()-S.conferma["reg"+r.id]<4000;
  return `<div class="sh-head"><div><div class="eyebrow">Regola imparata</div><h2>«${esc(r.testo)}»</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <label class="field"><span>Se la descrizione contiene</span><input data-sheet="testo" value="${esc(sheet.testo)}"></label>
  <p class="hint" id="conta-testo" style="margin-top:6px">${nMov(contaTesto(sheet.testo)," di questo conto")}</p>
  <div class="sec"><h3>Allora la categoria è</h3>${chipsCategorie(C,sheet.sel)}</div>
  <div class="sh-foot"><button class="btn ${conf?"danger":"ghost"}" data-act="reg-elimina">${conf?"Tocca di nuovo per eliminare":"Elimina regola"}</button><span class="grow"></span><button class="btn ghost" data-act="chiudi">Annulla</button><button class="btn" data-act="reg-salva">Salva</button></div>`;
}
async function salvaReg(){
  const C=C0(),testo=L.norm(sheet.testo);if(!testo){toast("Scrivi il testo da riconoscere.");return;}
  if(C.regole.some(r=>r.testo===testo&&r.id!==sheet.id)){toast("Esiste già una regola con questo testo.");return;}
  const {error}=await sb.from("regole").update({testo,categoria:sheet.sel}).eq("id",sheet.id);if(error)return errore(error);
  Object.assign(C.regole.find(r=>r.id===sheet.id),{testo,categoria:sheet.sel});
  prepara(S.conto);chiudi();renderAll();toast("Regola aggiornata.");
}
async function eliminaReg(){
  const k="reg"+sheet.id;
  if(!(S.conferma[k]&&Date.now()-S.conferma[k]<4000)){S.conferma[k]=Date.now();renderSheet();return;}
  const C=C0(),{error}=await sb.from("regole").delete().eq("id",sheet.id);if(error)return errore(error);
  C.regole=C.regole.filter(r=>r.id!==sheet.id);prepara(S.conto);chiudi();renderAll();toast("Regola eliminata.");
}

/* ---------- obiettivi ---------- */
// Risparmio = entrate - uscite (giroconti e investimenti esclusi). Investimento = movimenti nelle categorie di tipo investimento.
const valoreMese=(C,o,k)=>{const t=C.tot[k];return t?(o.tipo==="risparmio"?t.r:t.inv):0;};
function progresso(C,o){
  const dal=o.dal.slice(0,7),al=o.al?o.al.slice(0,7):null,fine=C.ultimo||ymOggi();
  if(o.modo==="mensile"){
    let k=S.mese;if(k<dal)k=dal;if(al&&k>al)k=al;
    const v=valoreMese(C,o,k);
    const storia=mesiTra(ymAdd(k,-5)<dal?dal:ymAdd(k,-5),k).map(x=>({k:x,ok:valoreMese(C,o,x)>=o.importo}));
    return {v,target:o.importo,etichetta:ymNome(k),storia,stato:v>=o.importo?["ok","Obiettivo del mese raggiunto"]:["","Mancano "+eur(o.importo-v)]};
  }
  const a=al&&al<fine?al:fine,v=fine<dal?0:mesiTra(dal,a).reduce((s,k)=>s+valoreMese(C,o,k),0);
  let stato=v>=o.importo?["ok","Raggiunto"]:["","Mancano "+eur(o.importo-v)];
  if(al&&v<o.importo&&fine>=dal){const tot=mesiTra(dal,al).length,pass=Math.min(tot,mesiTra(dal,a).length),atteso=o.importo*pass/tot;
    stato=v>=atteso?["ok","In linea con la scadenza"]:["late","Indietro di "+eur(atteso-v)+" sulla tabella di marcia"];}
  return {v,target:o.importo,etichetta:`dal ${ymNome(dal)}${al?" al "+ymNome(al):""}`,stato};
}
function cardObiettivo(C,o){
  const p=progresso(C,o),pc=Math.max(0,Math.min(100,p.v/p.target*100));
  return `<div class="card goal"><div class="top"><div><div class="tipo">${o.tipo==="risparmio"?"Risparmio":"Investimento"} · ${o.modo==="mensile"?"ogni mese":"in totale"}</div><div class="nome">${esc(o.nome)}</div></div><button class="btn ghost small" data-act="obi-mod" data-id="${o.id}">Modifica</button></div>
  <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${p.target}" aria-valuenow="${Math.max(0,p.v).toFixed(2)}" aria-label="${esc(o.nome)}"><span style="width:${pc}%"></span></div>
  <div class="vals num"><span><b>${eurS(p.v)}</b> di ${eur(p.target)}</span><span class="meta">${esc(p.etichetta)}</span></div>
  <span class="state ${p.stato[0]}">${p.stato[0]==="ok"?"✓ ":""}${esc(p.stato[1])}</span>
  ${p.storia?`<div class="months" aria-label="Ultimi mesi">${p.storia.map(s=>`<span class="${s.ok?"hit":""}" title="${ymNome(s.k)}: ${s.ok?"raggiunto":"non raggiunto"}">${MESI3[+s.k.slice(5)-1]}${s.ok?" ✓":""}</span>`).join("")}</div>`:""}</div>`;
}
function vObiettivi(C){
  const inv=C.cats.filter(c=>c.tipo==="investimento").map(c=>c.id),nInv=C.mov.filter(m=>inv.includes(m._c.id)).length;
  let h=`<div class="toolbar"><p class="meta grow">Gli obiettivi mensili si leggono sul mese scelto in Panoramica (${ymNome(S.mese)}).</p><button class="btn" data-act="obi-nuovo">Nuovo obiettivo</button></div>`;
  if(!C.obi.length)h+=`<div class="card empty"><b>Nessun obiettivo.</b>Esempi: «Risparmiare 500 € al mese», «Fondo emergenza: 5.000 € entro dicembre 2027», «Investire 200 € al mese nel PAC».</div>`;
  else h+=`<div class="goals">${C.obi.map(o=>cardObiettivo(C,o)).join("")}</div>`;
  if(C.obi.some(o=>o.tipo==="investimento")&&!nInv)h+=`<p class="warnline" style="margin-top:14px">Nessun movimento è ancora nella categoria «Investimenti». Apri un bonifico verso il broker o il fondo e mettilo in quella categoria, con «ricorda» attivo: l'app lo riconoscerà anche nei prossimi mesi.</p>`;
  return h;
}
function sheetObi(){
  const f=sheet.f,o=sheet.id?C0().obi.find(x=>x.id===sheet.id):null;
  const seg=(k,opts)=>`<div class="seg" role="group">${opts.map(([v,t])=>`<button data-act="obi-f" data-k="${k}" data-v="${v}" aria-pressed="${f[k]===v}">${t}</button>`).join("")}</div>`;
  const conf=o&&S.conferma["obi"+o.id]&&Date.now()-S.conferma["obi"+o.id]<4000;
  return `<div class="sh-head"><div><div class="eyebrow">${o?"Modifica obiettivo":"Nuovo obiettivo"}</div><h2>${esc(f.nome||"Obiettivo")}</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <div style="display:flex;flex-direction:column;gap:12px">
  ${seg("tipo",[["risparmio","Risparmio"],["investimento","Investimento"]])}
  <p class="hint">${f.tipo==="risparmio"?"Conta quanto resta: entrate meno uscite del conto (giroconti e investimenti esclusi).":"Conta i movimenti nelle categorie di tipo «Investimento» (es. bonifici al broker, PAC, fondo pensione)."}</p>
  <label class="field"><span>Nome</span><input data-sheet="nome" value="${esc(f.nome)}" maxlength="50" placeholder="${f.tipo==="risparmio"?"Es. Fondo emergenza":"Es. PAC ETF"}"></label>
  <label class="field"><span>Importo (€)</span><input data-sheet="importo" inputmode="decimal" value="${esc(f.importo)}" placeholder="500"></label>
  ${seg("modo",[["mensile","Ogni mese"],["totale","In totale"]])}
  <div style="display:flex;gap:10px;flex-wrap:wrap"><label class="field" style="flex:1 1 150px"><span>Dal mese</span><input type="month" data-sheet="dal" value="${esc(f.dal)}"></label>
  <label class="field" style="flex:1 1 150px"><span>${f.modo==="totale"?"Entro il mese (facoltativo)":"Fino al mese (facoltativo)"}</span><input type="month" data-sheet="al" value="${esc(f.al)}"></label></div>
  </div>
  <div class="sh-foot">${o?`<button class="btn ${conf?"danger":"ghost"}" data-act="obi-elimina">${conf?"Tocca di nuovo per eliminare":"Elimina"}</button>`:""}<span class="grow"></span><button class="btn ghost" data-act="chiudi">Annulla</button><button class="btn" data-act="obi-salva">Salva</button></div>`;
}
async function salvaObi(){
  const C=C0(),f=sheet.f,importo=L.numero(f.importo);
  if(!f.nome.trim()){toast("Scrivi un nome.");return;}
  if(!importo||importo<=0){toast("Scrivi un importo valido.");return;}
  if(!f.dal){toast("Scegli il mese di inizio.");return;}
  if(f.al&&f.al<f.dal){toast("La fine viene prima dell'inizio.");return;}
  const row={conto:S.conto,tipo:f.tipo,nome:f.nome.trim(),importo,modo:f.modo,dal:f.dal+"-01",al:f.al?f.al+"-01":null};
  const r=sheet.id?await sb.from("obiettivi").update(row).eq("id",sheet.id).select().single():await sb.from("obiettivi").insert(row).select().single();
  if(r.error)return errore(r.error);
  const o={...r.data,importo:Number(r.data.importo)};
  C.obi=sheet.id?C.obi.map(x=>x.id===o.id?o:x):C.obi.concat(o);
  chiudi();renderAll();toast("Obiettivo salvato.");
}
async function eliminaObi(){
  const k="obi"+sheet.id;
  if(!(S.conferma[k]&&Date.now()-S.conferma[k]<4000)){S.conferma[k]=Date.now();renderSheet();return;}
  const {error}=await sb.from("obiettivi").delete().eq("id",sheet.id);if(error)return errore(error);
  C0().obi=C0().obi.filter(o=>o.id!==sheet.id);chiudi();renderAll();toast("Obiettivo eliminato.");
}

/* ---------- collegamento con la banca ---------- */
// Tutto passa dalla funzione Supabase "banca" (supabase/functions/banca): la chiave di Enable Banking non è nel browser.
async function funzioneBanca(azione,dati){
  const {data,error}=await sb.functions.invoke("banca",{body:{azione,...dati}});
  if(error){let m=error.message;try{const j=await error.context.json();if(j.errore)m=j.errore;}catch(e){}throw new Error(m);}
  return data;
}
// D.banca[conto][fonte]: fonte "conto" = Banca Valsabbina, "carta" = prepagata letta da NEXI.
async function caricaCollegamenti(){
  let r=await sb.from("banca_collegamenti").select("conto,fonte,iban,scade,collegato,ultimo_sync,esito");
  if(r.error)r=await sb.from("banca_collegamenti").select("conto,iban,scade,collegato,ultimo_sync,esito"); // colonna fonte non ancora creata
  D.banca={};if(r.error)return; // tabella assente = schema.sql non ancora rieseguito
  for(const c of r.data)(D.banca[c.conto]??={})[c.fonte||"conto"]=c;
}
const FONTI={conto:{banca:"valsabbina",titolo:"Conto corrente",nome:"Banca Valsabbina",cosa:"conto"},
  carta:{banca:"nexi",titolo:"Carta prepagata",nome:"NEXI",cosa:"carta"}};
async function ricaricaConti(){
  const {data}=await sb.from("conti").select("*");
  if(data)D.conti=D.conti.map(c=>data.find(x=>x.id===c.id)||c);
}
const quando=ts=>{const d=new Date(ts),o=new Date(),ieri=new Date(o.getTime()-864e5),ora=d.toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
  return d.toDateString()===o.toDateString()?"oggi alle "+ora:d.toDateString()===ieri.toDateString()?"ieri alle "+ora:giorno(d.toISOString().slice(0,10))+" alle "+ora;};
const giorniA=ts=>Math.ceil((new Date(ts)-Date.now())/864e5);
// Un blocco per fonte. Il conto in comune non ha una prepagata propria da collegare qui se nessuno l'ha collegata.
function bloccoBanca(fonte){
  const F=FONTI[fonte],c=(D.banca[S.conto]||{})[fonte],occ=S.banca,ap=occ==="collega-"+fonte;
  const testa=`<div class="sec"><h3>${F.titolo} <span class="meta">· ${F.nome}</span></h3>`;
  if(!c)return testa+(fonte==="conto"
    ?`<p>Collega il conto ${esc(contoNome(S.conto))} a Banca Valsabbina: i movimenti nuovi arriveranno da soli due volte al giorno.</p>`
    :`<p>Collega la prepagata da NEXI: le spese fatte con la carta entrano in questo conto con le loro categorie e le ricariche diventano un giroconto, così non si contano due volte.</p>`)+`
    <button class="btn${fonte==="carta"?" ghost":""}" style="margin-top:10px" data-act="banca-collega" data-fonte="${fonte}" ${occ?"disabled":""}>${ap?"Apro "+F.nome+"…":fonte==="conto"?"Collega la banca":"Collega la prepagata"}</button></div>`;
  const gg=giorniA(c.scade),scaduto=c.esito==="scaduto"||gg<=0,k="scollega-"+fonte,conf=S.conferma[k]&&Date.now()-S.conferma[k]<4000;
  return testa+`<div class="facts"><div><span>${fonte==="carta"?"Carta":"Conto"}</span> ${c.iban?"…"+esc(c.iban):F.nome}</div>
    <div><span>Ultimo aggiornamento</span> ${c.ultimo_sync?quando(c.ultimo_sync):"mai"}</div>
    <div><span>Consenso valido fino al</span> ${giorno(c.scade.slice(0,10))}</div></div>
    ${scaduto?`<p class="warnline" style="margin-top:10px">Il consenso è scaduto: i movimenti non arrivano più. Tocca «Rinnova il consenso» e rifai l'accesso a ${F.nome}.</p>`
      :gg<=21?`<p class="warnline" style="margin-top:10px">Il consenso scade tra ${gg} ${gg===1?"giorno":"giorni"}: rinnovalo per non perdere aggiornamenti.</p>`
      :c.esito?`<p class="warnline" style="margin-top:10px">L'ultimo aggiornamento non è riuscito: ${esc(c.esito)}</p>`:""}
    <div class="sh-foot" style="flex-wrap:wrap"><button class="btn ${conf?"danger":"ghost"} small" data-act="banca-scollega" data-fonte="${fonte}">${conf?"Tocca di nuovo per scollegare":"Scollega"}</button><span class="grow"></span>
    <button class="btn ${scaduto||gg<=21?"":"ghost"}" data-act="banca-collega" data-fonte="${fonte}" ${occ?"disabled":""}>${ap?"Apro "+F.nome+"…":"Rinnova il consenso"}</button></div></div>`;
}
function cardBanca(){
  const L0=D.banca[S.conto]||{},vivo=Object.values(L0).some(c=>c.esito!=="scaduto"&&giorniA(c.scade)>0);
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2 class="dotted">Collegamento con la banca</h2>
    ${vivo?`<button class="btn small" data-act="banca-aggiorna" ${S.banca?"disabled":""}>${S.banca==="aggiorna"?"Aggiorno…":"Aggiorna ora"}</button>`:""}</div>
    ${bloccoBanca("conto")}${bloccoBanca("carta")}
    <p class="hint" style="margin-top:14px">Sola lettura: l'app vede movimenti e saldo, non può disporre pagamenti. Il consenso si dà sul sito della banca, vale 6 mesi e passa da Enable Banking, un intermediario autorizzato.</p></div>`;
}
function vBanca(C){
  let h=cardBanca();
  h+=`<div class="card" style="margin-top:14px"><div class="card-head"><h2 class="dotted">Movimenti arrivati</h2>${C.primo?`<p class="meta">movimenti dal ${giorno(C.mov[C.mov.length-1].data)} al ${giorno(C.mov[0].data)}</p>`:""}</div>`;
  if(!C.imps.length)h+=`<p class="meta">Ancora nessuno.</p>`;
  else h+=C.imps.map(i=>{
    return `<div class="hist"><div><b>${esc(i.nome_file||"XLS")}</b><div class="s">${i.dal?giorno(i.dal)+" – "+giorno(i.al):""} · ${i.righe_importate} ${i.righe_importate===1?"nuovo":"nuovi"}${i.righe_duplicate?` · ${i.righe_duplicate} già presenti`:""} · ${new Date(i.caricato).toLocaleDateString("it-IT")}</div></div>
    </div>`;}).join("");
  h+=`</div>`;
  return h;
}
async function bancaCollega(fonte){
  S.banca="collega-"+fonte;renderMain();
  try{const {url}=await funzioneBanca("avvia",{banca:FONTI[fonte].banca});location.href=url;}
  catch(e){S.banca=null;renderMain();toast("Non riesco ad aprire "+FONTI[fonte].nome+": "+e.message);}
}
const riassunto=esiti=>{const ok=esiti.filter(x=>!x.errore),n=ok.reduce((s,x)=>s+x.nuovi,0),ko=esiti.find(x=>x.errore);
  return ko?`${contoNome(ko.conto)}${ko.fonte==="carta"?" (prepagata)":""}: ${ko.errore}`:n?`Arrivati ${n} ${n===1?"movimento nuovo":"movimenti nuovi"}.`:"Nessun movimento nuovo: è già tutto aggiornato.";};
async function dopoBanca(esiti){
  await Promise.all([caricaCollegamenti(),ricaricaConti()]);
  for(const k in D.c)if(k!==S.conto)delete D.c[k];
  await caricaConto(S.conto).catch(()=>{});
  S.banca=null;renderAll();toast(riassunto(esiti));
}
async function bancaAggiorna(){
  S.banca="aggiorna";renderMain();
  try{const {esiti}=await funzioneBanca("aggiorna",{conto:S.conto});await dopoBanca(esiti);}
  catch(e){S.banca=null;renderMain();toast("Aggiornamento non riuscito: "+e.message);}
}
async function bancaScollega(fonte){
  const k="scollega-"+fonte;
  if(!(S.conferma[k]&&Date.now()-S.conferma[k]<4000)){S.conferma[k]=Date.now();renderMain();setTimeout(()=>{if(S.tab==="banca")renderMain();},4100);return;}
  try{await funzioneBanca("scollega",{conto:S.conto,fonte});await caricaCollegamenti();renderMain();toast((fonte==="carta"?"Prepagata":"Conto")+" scollegato: i movimenti già arrivati restano.");}
  catch(e){toast("Non riesco a scollegare: "+e.message);}
}
// Al ritorno dalla banca: apre la sessione e chiede a quale conto dell'app va ogni conto visto nel consenso.
async function confermaBanca(r){
  S.tab="banca";
  if(r.errore){renderAll();toast("La banca non ha dato il consenso: "+r.errore);return;}
  toast("Collegamento in corso…");
  try{
    const {conti,banca}=await funzioneBanca("conferma",r);
    const usati=new Set();
    const scelte=conti.map(c=>{const s=D.conti.some(x=>x.id===c.suggerito)&&!usati.has(c.suggerito)?c.suggerito:"";if(s)usati.add(s);return s;});
    sheet={tipo:"abbina",state:r.state,conti,scelte,carta:banca==="nexi"};renderAll();renderSheet();
  }catch(e){renderAll();toast("Collegamento non riuscito: "+e.message);}
}
function sheetAbbina(){
  const ok=sheet.scelte.some(Boolean);
  const carta=sheet.carta;
  return `<div class="sh-head"><div><div class="eyebrow">${carta?"NEXI · carta prepagata":"Banca Valsabbina"}</div><h2>${carta?"In quale conto va la carta?":"Quali conti colleghi?"}</h2></div><button class="iconbtn" data-act="chiudi" aria-label="Chiudi">×</button></div>
  <p class="hint">${carta?"Scegli il conto dell'app in cui far arrivare le spese della carta: di solito quello da cui parte la ricarica.":"Per ogni conto della banca scegli il conto dell'app in cui far arrivare i movimenti."} I movimenti già presenti non vengono duplicati.</p>
  ${sheet.conti.length?"":`<p class="warnline">${carta?"NEXI":"La banca"} non ha mandato nessun conto. Se hai dato il consenso, il conto va prima collegato anche nel pannello di controllo di Enable Banking.</p>`}
  ${sheet.conti.map((c,i)=>`<div class="sec"><h3>${esc(c.nome||(carta?"Carta":"Conto"))}${c.iban?` <span class="meta">· …${esc(c.iban)}</span>`:""}</h3>
    <div class="chips">${D.conti.map(x=>`<button class="chip" data-act="abbina-scegli" data-i="${i}" data-conto="${x.id}" aria-pressed="${sheet.scelte[i]===x.id}">${esc(x.nome)}</button>`).join("")}
    <button class="chip" data-act="abbina-scegli" data-i="${i}" data-conto="" aria-pressed="${!sheet.scelte[i]}">Non collegare</button></div></div>`).join("")}
  <div class="sh-foot"><span class="grow"></span><button class="btn ghost" data-act="chiudi">Annulla</button><button class="btn" data-act="abbina-ok" id="abbina-ok" ${ok&&!sheet.occ?"":"disabled"}>${sheet.occ?"Scarico i movimenti…":"Collega e scarica i movimenti"}</button></div>`;
}
async function abbina(){
  sheet.occ=true;renderSheet();
  try{
    const {esiti}=await funzioneBanca("abbina",{state:sheet.state,scelte:sheet.conti.map((c,i)=>({uid:c.uid,conto:sheet.scelte[i]}))});
    const primo=sheet.scelte.find(Boolean);chiudi();
    if(primo&&primo!==S.conto){S.conto=primo;setPref("conto",primo);}
    await dopoBanca(esiti);
  }catch(e){sheet.occ=false;renderSheet();toast("Collegamento non riuscito: "+e.message);}
}
/* ===================== pannello, messaggi ===================== */
function renderSheet(){
  if(!sheet){$("overlay").hidden=true;return;}
  const html=sheet.tipo==="mov"?sheetMov():sheet.tipo==="contanti"?sheetContanti():sheet.tipo==="filtri"?sheetFiltri():sheet.tipo==="cat"?sheetCat():sheet.tipo==="reg"?sheetReg():sheet.tipo==="abbina"?sheetAbbina():sheetObi();
  if(!sheet)return;
  const el=$("sheet"),top=el.scrollTop;el.innerHTML=html;$("overlay").hidden=false;el.scrollTop=top;
  document.body.style.overflow="hidden";
}
function chiudi(){sheet=null;$("overlay").hidden=true;document.body.style.overflow="";}
let toastT;function toast(msg){const el=$("toast");el.textContent=msg;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>el.hidden=true,3800);}
function errore(e){console.error(e);toast(!navigator.onLine?"Sei offline: riprova quando torna la connessione.":"Non salvato: "+(e.message||"errore"));}

/* ===================== eventi ===================== */
document.addEventListener("click",e=>{
  if(e.target.id==="overlay"){chiudi();return;}
  if(S.menu&&!e.target.closest(".menu")){S.menu=false;renderTabs();} // clic fuori: il menu si chiude
  const b=e.target.closest("[data-act]");if(!b)return;const a=b.dataset.act;
  if(a==="logout"){esci();return;}
  if(!C0()&&a!=="conto")return;
  if(a==="menu"){S.menu=!S.menu;renderTabs();return;}
  if(a==="conto"){if(S.conto!==b.dataset.id)apriConto(b.dataset.id);}
  else if(a==="tab"){S.menu=false;S.tab=b.dataset.tab;S.lim=150;nascondiTip();renderAll();scrollTo({top:0});}
  else if(a==="per"){S.per=b.dataset.per;S.lim=150;renderMain();}
  else if(a==="mese"){S.mese=b.dataset.ym;S.per="mese";S.lim=150;nascondiTip();renderMain();}
  else if(a==="anno")scegliAnno(b.dataset.y);
  else if(a==="vai-todo"||a==="vai-todo-tutti"){S.tab="movimenti";S.filtri={...filtriVuoti(),cats:["da-classificare"]};S.verso="tutti";S.q="";if(a==="vai-todo-tutti")S.per="tutto";renderAll();}
  else if(a==="vai-cat"&&S.tab==="dashboard"){S.tab="movimenti";S.filtri={...filtriVuoti(),cats:[b.dataset.cat]};S.verso="tutti";S.q="";
    if(S.dper&&S.dper!=="12m"){S.per="anno";S.mese=S.dper+S.mese.slice(4);}else S.per="tutto";nascondiTip();renderAll();scrollTo({top:0});}
  else if(a==="vai-cat"||a==="vai-cat-tutto"){S.tab="movimenti";S.filtri={...filtriVuoti(),cats:[b.dataset.cat]};S.verso="tutti";S.q="";if(a==="vai-cat-tutto")S.per="tutto";renderAll();scrollTo({top:0});}
  else if(a==="altri"){S.lim+=150;renderLista();}
  else if(a==="mov")apriMov(b.dataset.id);
  else if(a==="contanti-nuovo"){sheet={tipo:"contanti",id:null,f:{verso:"uscita",importo:"",data:oggiISO(),descr:"",cat:""}};renderSheet();setTimeout(()=>document.querySelector('[data-sheet="importo"]')?.focus(),50);}
  else if(a==="c-verso"){sheet.f.verso=b.dataset.v;sheet.f.cat="";renderSheet();}
  else if(a==="c-cat"){sheet.f.cat=sheet.f.cat===b.dataset.cat?"":b.dataset.cat;renderSheet();}
  else if(a==="c-salva")salvaContanti();
  else if(a==="c-elimina")eliminaContanti();
  else if(a==="verso"){S.verso=b.dataset.v;S.lim=150;renderMain();}
  else if(a==="filtri"){sheet={tipo:"filtri",f:{...S.filtri,cats:S.filtri.cats.slice()}};renderSheet();}
  else if(a==="f-cat"){const c=sheet.f.cats,id=b.dataset.cat;sheet.f.cats=c.includes(id)?c.filter(x=>x!==id):c.concat(id);renderSheet();}
  else if(a==="f-tog"){sheet.f[b.dataset.k]=!sheet.f[b.dataset.k];renderSheet();}
  else if(a==="f-azzera"){sheet.f=filtriVuoti();renderSheet();}
  else if(a==="f-applica"){S.filtri=sheet.f;S.lim=150;chiudi();renderMain();}
  else if(a==="togli-filtro"){const k=b.dataset.k,f=S.filtri;if(k.startsWith("cat:"))f.cats=f.cats.filter(x=>x!==k.slice(4));else if(k==="min"||k==="max")f[k]="";else f[k]=false;S.lim=150;renderMain();}
  else if(a==="azzera-filtri"){S.filtri=filtriVuoti();S.lim=150;renderMain();}
  else if(a==="chiudi")chiudi();
  else if(a==="scegli-cat"){sheet.sel=b.dataset.cat;renderSheet();}
  else if(a==="mov-salva")salvaMov();
  else if(a==="mov-auto")movAuto();
  else if(a==="cat-nuova"){sheet={tipo:"cat",id:null,f:{nome:"",tipo:"normale",verso:"uscita",padre:""}};renderSheet();}
  else if(a==="cat-mod"){const c=C0().byId[b.dataset.cat];sheet={tipo:"cat",id:c.id,f:{nome:c.nome,tipo:c.tipo,verso:c.verso,padre:c.padre||""}};renderSheet();}
  else if(a==="cat-f"){sheet.f[b.dataset.k]=b.dataset.v;renderSheet();}
  else if(a==="cat-salva")salvaCat();
  else if(a==="cat-elimina")eliminaCat();
  else if(a==="reg-mod"){const r=C0().regole.find(x=>x.id===+b.dataset.id);sheet={tipo:"reg",id:r.id,testo:r.testo,sel:r.categoria};renderSheet();}
  else if(a==="reg-salva")salvaReg();
  else if(a==="reg-elimina")eliminaReg();
  else if(a==="obi-nuovo"){sheet={tipo:"obi",id:null,f:{tipo:"risparmio",nome:"",importo:"",modo:"mensile",dal:ymOggi(),al:""}};renderSheet();}
  else if(a==="obi-mod"){const o=C0().obi.find(x=>x.id===+b.dataset.id);sheet={tipo:"obi",id:o.id,f:{tipo:o.tipo,nome:o.nome,importo:String(o.importo).replace(".",","),modo:o.modo,dal:o.dal.slice(0,7),al:o.al?o.al.slice(0,7):""}};renderSheet();}
  else if(a==="obi-f"){sheet.f[b.dataset.k]=b.dataset.v;renderSheet();}
  else if(a==="obi-salva")salvaObi();
  else if(a==="obi-elimina")eliminaObi();
  else if(a==="banca-collega")bancaCollega(b.dataset.fonte||"conto");
  else if(a==="banca-aggiorna")bancaAggiorna();
  else if(a==="banca-scollega")bancaScollega(b.dataset.fonte||"conto");
  else if(a==="abbina-scegli"){const i=+b.dataset.i,c=b.dataset.conto;sheet.scelte=sheet.scelte.map((x,j)=>j===i?c:c&&x===c?"":x);renderSheet();} // un conto dell'app riceve un solo conto della banca
  else if(a==="abbina-ok")abbina();
});
document.addEventListener("input",e=>{
  const t=e.target;
  if(t.dataset.input==="q"){S.q=t.value;S.lim=150;renderLista();}
  else if(t.dataset.filtro&&sheet&&sheet.tipo==="filtri"){sheet.f[t.dataset.filtro]=t.value.trim();const n=filtrati(sheet.f).length,b=$("f-applica");if(b)b.textContent=`Mostra ${n} ${n===1?"movimento":"movimenti"}`;}
  else if(t.dataset.sheet&&sheet){
    const k=t.dataset.sheet;
    if(sheet.f&&k in sheet.f)sheet.f[k]=t.value; else if(k!=="regola")sheet[k]=t.value;
    if(k==="testo"){const el=$("conta-testo");if(el){el.textContent=nMov(contaTesto(t.value)," di questo conto");}}
  }
});
document.addEventListener("change",e=>{
  const t=e.target;
  if(t.dataset.sheet==="regola"){sheet.regola=t.checked;renderSheet();}
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(sheet)chiudi();else if(S.menu){S.menu=false;renderTabs();}}});
let rT;addEventListener("resize",()=>{clearTimeout(rT);rT=setTimeout(()=>{disegnaGrafici();if(typeof disegnaDashboard==="function")disegnaDashboard();},120);});

/* ===================== accesso e avvio ===================== */
function showLogin(msg){
  document.body.className="signed-out";$("app").hidden=true;$("login").hidden=false;
  const er=$("login-err");er.hidden=!msg;er.textContent=msg||"";
}
async function apriConto(id){
  S.conto=id;setPref("conto",id);S.filtri=filtriVuoti();S.verso="tutti";S.q="";chiudi();
  if(!D.c[id]){S.msg="Carico i movimenti…";renderAll();
    try{await caricaConto(id);}catch(e){S.msg=nonPronto(e)?"<b>Database da preparare.</b><br>Esegui <code>supabase/schema.sql</code> nel SQL Editor di Supabase.":"Non riesco a caricare il conto: controlla la connessione.";console.error(e);renderAll();return;}
    if(S.conto!==id)return;
    S.mese=D.c[id].ultimo||ymOggi();
  }
  renderAll();
}
async function start(){
  document.body.className="signed-in";$("login").hidden=true;$("app").hidden=false;
  S.msg="Carico i conti…";D.conti=[];D.c={};S.conto=null;renderAll();
  const {data:me,error:e1}=await sb.from("membri").select("persona").eq("user_id",user.id).maybeSingle();
  if(e1||!me){S.msg=e1?"Non riesco a collegarmi: controlla la connessione.":`<b>Account non abilitato.</b><br>Hai fatto l'accesso come ${esc(user.email)}, ma questo account non è nella tabella «membri».<br><br><button class="btn ghost" data-act="logout">Log out</button>`;renderMain();return;}
  persona=me.persona;
  const {data:conti,error}=await sb.from("conti").select("*");
  if(error||!conti?.length){S.msg=nonPronto(error)||!conti?.length?"<b>Database da preparare.</b><br>Esegui <code>supabase/schema.sql</code> nel SQL Editor di Supabase.":"Non riesco a caricare i conti.";renderMain();return;}
  const ord={[persona]:0,comune:1};
  D.conti=conti.sort((a,b)=>(ord[a.id]??2)-(ord[b.id]??2));
  if(typeof dashOk==="function"&&dashOk())S.tab="dashboard";
  const pref0=pref("conto","");
  await caricaCollegamenti();
  await apriConto(D.conti.some(c=>c.id===pref0)?pref0:D.conti[0].id);
  if(ritornoBanca){const r=ritornoBanca;ritornoBanca=null;confermaBanca(r);}
  if(chan)sb.removeChannel(chan);
  let t;const ricarica=()=>{clearTimeout(t);t=setTimeout(aggiorna,900);};
  chan=sb.channel("banking");
  for(const tab of ["importazioni","categorie","regole","obiettivi"])chan.on("postgres_changes",{event:"*",schema:"public",table:tab},ricarica);
  chan.on("postgres_changes",{event:"UPDATE",schema:"public",table:"movimenti"},ricarica).subscribe();
}
// Riallinea il conto aperto con il database senza disturbare chi sta scrivendo.
async function aggiorna(){
  const id=S.conto;if(!id||!D.c[id])return;
  try{await Promise.all([caricaConto(id),caricaCollegamenti(),ricaricaConti()]);}catch(e){return;}
  if(id!==S.conto)return;
  for(const k in D.c)if(k!==id)delete D.c[k];
  const a=document.activeElement;
  if(sheet||(a&&a.closest&&a.closest("#main")&&/INPUT|SELECT|TEXTAREA/.test(a.tagName))){renderConti();renderTabs();if(S.tab==="movimenti")renderLista();return;}
  renderAll();
}
async function esci(){
  try{await sb.auth.signOut({scope:"local"});}catch(e){}
  if(chan){sb.removeChannel(chan);chan=null;}
  D.conti=[];D.c={};S.conto=null;user=null;chiudi();showLogin();
}
$("login-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const btn=$("login-btn");btn.disabled=true;showLogin();
  const {error}=await sb.auth.signInWithPassword({email:$("login-email").value.trim(),password:$("login-pw").value});
  btn.disabled=false;
  if(error)showLogin(/invalid/i.test(error.message)?"Email o password non corrette.":!navigator.onLine?"Serve la connessione per accedere.":"Accesso non riuscito, riprova.");
  else $("login-pw").value="";
});
let authSeen=false;
sb.auth.onAuthStateChange((ev,session)=>{
  const u=session?.user||null;
  if(authSeen&&(u?u.id:null)===(user?user.id:null))return;
  authSeen=true;user=u;
  if(user)setTimeout(start,0); else {if(chan){sb.removeChannel(chan);chan=null;}showLogin();}
});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&user&&C0())aggiorna();});
if("serviceWorker" in navigator)addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
