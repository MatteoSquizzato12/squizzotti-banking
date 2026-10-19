/* Logica senza interfaccia: lettura degli XLS di Banca Valsabbina, chiave anti-duplicati,
   esercente, categorie predefinite e classificazione. Funziona nel browser e in Node (per i test). */
(function(root){
"use strict";

/* ---------- lettura XLS ---------- */
// Colonne dell'estratto conto Valsabbina: Data contabile | Valuta | Dare | Avere | Divisa | Causale | Descrizione
const COLONNE={data:/^data\s*contabile$/i,valuta:/^(data\s*)?valuta$/i,dare:/^dare$/i,avere:/^avere$/i,divisa:/^divisa$/i,causale:/^causale$/i,descrizione:/^descrizione$/i};

function dataISO(v){
  if(v==null||v==="")return null;
  if(typeof v==="number"){ // numero di serie Excel
    const d=new Date(Math.round((v-25569)*86400000));
    return d.toISOString().slice(0,10);
  }
  if(v instanceof Date&&!isNaN(v))return v.getFullYear()+"-"+String(v.getMonth()+1).padStart(2,"0")+"-"+String(v.getDate()).padStart(2,"0");
  const m=String(v).trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if(m){const y=m[3].length===2?"20"+m[3]:m[3];return y+"-"+m[2].padStart(2,"0")+"-"+m[1].padStart(2,"0");}
  const iso=String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso?iso[1]+"-"+iso[2]+"-"+iso[3]:null;
}
function numero(v){
  if(v==null||v==="")return null;
  if(typeof v==="number")return v;
  let s=String(v).replace(/[€\s]/g,"");
  if(/,\d{1,2}$/.test(s))s=s.replace(/\./g,"").replace(",","."); // 1.234,56
  const n=parseFloat(s);
  return isNaN(n)?null:n;
}
const pulisci=s=>String(s==null?"":s).replace(/\s+/g," ").trim();

// righe = array di array (prima riga utile = intestazione). Restituisce {movimenti, scartate} oppure lancia un errore leggibile.
function leggiRighe(righe){
  let h=-1,col=null;
  for(let i=0;i<Math.min(righe.length,30);i++){
    const r=(righe[i]||[]).map(c=>pulisci(c));
    const c={};
    r.forEach((x,j)=>{for(const k in COLONNE)if(c[k]==null&&COLONNE[k].test(x))c[k]=j;});
    if(c.data!=null&&c.descrizione!=null&&(c.dare!=null||c.avere!=null)){h=i;col=c;break;}
  }
  if(h<0)throw new Error("Non trovo le colonne dell'estratto conto (Data contabile, Dare, Avere, Descrizione). È un XLS di Banca Valsabbina?");
  const movimenti=[];let scartate=0;
  for(const r of righe.slice(h+1)){
    if(!r||r.every(c=>c==null||c===""))continue;
    const data=dataISO(r[col.data]);
    const dare=col.dare!=null?numero(r[col.dare]):null, avere=col.avere!=null?numero(r[col.avere]):null;
    let importo=null;
    if(dare)importo=-Math.abs(dare); else if(avere)importo=Math.abs(avere);
    const descrizione=pulisci(r[col.descrizione]);
    if(!data||!importo||!descrizione){scartate++;continue;}
    const divisa=col.divisa!=null?pulisci(r[col.divisa]):"EUR";
    const m={data,valuta:col.valuta!=null?dataISO(r[col.valuta]):null,importo:Math.round(importo*100)/100,
      causale:col.causale!=null?pulisci(r[col.causale]):"",descrizione,divisa:divisa||"EUR"};
    m.chiave=chiave(m);
    movimenti.push(m);
  }
  return {movimenti,scartate};
}
// Nel browser: XLSX = SheetJS. buffer = ArrayBuffer del file.
function leggiXLS(XLSX,buffer){
  const wb=XLSX.read(buffer,{type:"array"});
  if(!wb.SheetNames.length)throw new Error("Il file è vuoto.");
  const righe=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:null});
  return leggiRighe(righe);
}

/* ---------- duplicati ---------- */
// Stesso giorno + stessa causale + stesso importo + stessa descrizione = stesso movimento.
function chiave(m){return [m.data,(m.causale||"").toUpperCase(),Number(m.importo).toFixed(2),pulisci(m.descrizione).toUpperCase()].join("|");}
// Divide le righe del file: "nuovi" (mai visti) e "duplicati" (già salvati). Le righe identiche dentro lo stesso file
// restano tutte: sono pagamenti veri ripetuti.
function confronta(movimentiFile,chiaviSalvate){
  const gia=new Set(chiaviSalvate);
  const nuovi=[],duplicati=[];
  for(const m of movimentiFile)(gia.has(m.chiave)?duplicati:nuovi).push(m);
  return {nuovi,duplicati};
}

/* ---------- esercente / controparte ---------- */
const TAGLIA=s=>pulisci(s).replace(/[.\s-]+$/,"");
function esercente(m){
  const d=pulisci(m.descrizione);
  let x;
  if((x=d.match(/C\/O\s+(.+?)(?:\s+CARTA\s+N\.|\s+-\s+CIRCUITO|$)/i)))return TAGLIA(x[1]);
  if((x=d.match(/(?:a vs favore|BONIFICO A VOSTRO FAVORE|DISPOSIZIONE VS\. FAVORE|EMOLUMENTI)\s+(.+?)\s+(?:Data Regolamento|Coord|CRO)/i)))return TAGLIA(x[1]);
  if((x=d.match(/(?:VS DISPOSIZIONE DI BONIFICO|Bonifico - SEPA istantaneo)\s+(.+?)\s+(?:Disposto in|DISPOSTO DA|Coor\.?\s*Benef)/i)))return TAGLIA(x[1]);
  if(/^DELEGHE/i.test(d))return "F24 (deleghe Agenzia delle Entrate)";
  // Addebiti diretti: il creditore sta dopo l'identificativo IT... e prima di " - "
  if(/ADDEBITO DIRETTO|PAGAMENTO UTENZA/i.test(d)){
    const noti=d.match(/\b(A2A|ENEL|HERA|IREN|EDISON|ENI PLENITUDE|SORGENIA|ACEA|TELECOM ?ITALIA|TIM|VODAFONE|WIND ?TRE|ILIAD|FASTWEB|GAMALIFE|GENERALI|ALLIANZ|UNIPOL|AXA|ZURICH|POSTE ?VITA)\b[^-]*/i);
    if(noti)return TAGLIA(noti[0]).replace(/\s+(SPA|S\.P\.A\.?|S P A)$/i," SPA");
    if((x=d.match(/IT\w{10,}\s+(.+?)\s+-/)))return TAGLIA(x[1]);
  }
  if((x=d.match(/^RICARICA CARTA/i)))return "Ricarica carta prepagata";
  return TAGLIA(d.replace(/\s+(Prg\.Car|CRO|Coord|Data Regolamento|N\.)\b.*$/i,"")).slice(0,60);
}
// Testo da proporre per una nuova regola: l'esercente in maiuscolo (es. "WE YOU LAVIS").
const testoRegola=m=>esercente(m).toUpperCase();

/* ---------- categorie predefinite ---------- */
// [id, nome, tipo, verso]. Il conto comune ha "Versamenti" al posto di "Al conto comune".
const BASE=[
  ["spesa","Spesa alimentare","normale","uscita"],
  ["ristoranti","Ristoranti e bar","normale","uscita"],
  ["casa","Casa e utenze","normale","uscita"],
  ["telefono","Telefono e internet","normale","uscita"],
  ["trasporti","Auto e trasporti","normale","uscita"],
  ["salute","Salute","normale","uscita"],
  ["sport","Sport e benessere","normale","uscita"],
  ["shopping","Shopping","normale","uscita"],
  ["svago","Svago e abbonamenti","normale","uscita"],
  ["viaggi","Viaggi","normale","uscita"],
  ["assicurazioni","Assicurazioni","normale","uscita"],
  ["tasse","Tasse e F24","normale","uscita"],
  ["banca","Commissioni e bolli","normale","uscita"],
  ["contanti","Prelievi contanti","normale","uscita"],
  ["prepagata","Ricarica prepagata","normale","uscita"],
  ["regali","Regali e famiglia","normale","uscita"],
  ["altre-uscite","Altre uscite","normale","uscita"],
  ["da-classificare","Da classificare","normale","uscita"],
  ["stipendio","Stipendio e compensi","normale","entrata"],
  ["rimborsi","Rimborsi","normale","entrata"],
  ["altre-entrate","Altre entrate","normale","entrata"],
  ["giroconti","Giroconti tra conti propri","trasferimento","uscita"],
  ["investimenti","Investimenti","investimento","uscita"]
];
function categoriePredefinite(conto){
  const l=BASE.slice();
  if(conto==="comune")l.splice(18,0,["versamenti","Versamenti di Matteo e Anna","normale","entrata"]);
  else l.splice(16,0,["conto-comune","Al conto comune","normale","uscita"]);
  return l.map(([id,nome,tipo,verso],i)=>({conto,id,nome,tipo,verso,ordine:i}));
}

/* ---------- classificazione ---------- */
// 1) scelta a mano sul movimento  2) regole imparate (la più lunga vince)  3) causale della banca
// 4) dizionario di esercenti italiani  5) "Da classificare" (uscite) o "Altre entrate" (entrate).
const CAUSALI={"EB":"banca","5E":"banca","0F":"banca","2J":"banca","18":"banca","4Y":"banca","4K":"banca","2U":"prepagata","FT":"tasse","(0":"contanti","B8":"stipendio"};
const DIZIONARIO=[
  ["giroconti-auto",/\bGIROCONTO\b/],
  ["spesa",/\b(ESSELUNGA|CONAD|COOP|CARREFOUR|LIDL|EUROSPIN|IPER\b|IPERCOOP|FAMILA|PAM\b|DESPAR|INTERSPAR|EUROSPAR|SPAR\b|MD\s+S\.?P\.?A|ALDI|PENNY|BENNET|TIGROS|SIGMA|CRAI|TODIS|IN'S|SUPERMERCAT|ALIMENTARI|MACELLERIA|PANIFICIO|PANETTERIA|FORNO|FRUTTA|ORTOFRUTTA|PESCHERIA|GASTRONOMIA|SALUMERIA|CASEIFICIO|MERCATO)/],
  ["ristoranti",/\b(MC ?DONALD|BURGER ?KING|KFC|RISTORANT|PIZZ|TRATTORIA|OSTERIA|LOCANDA|AGRITURISMO|BAR\b|CAFF|CAFE\b|CREMERIA|GELAT|PASTICCERIA|SUSHI|KEBAB|BIRRERIA|PUB\b|ENOTECA|TAVOLA CALDA|ROSTICCERIA|DELIVEROO|JUST ?EAT|GLOVO|AUTOGRILL|CHEF EXPRESS|STARBUCKS|BISTROT)/],
  ["casa",/\b(A2A|ENEL\b|ENEL ENERGIA|HERA\b|IREN\b|EDISON|PLENITUDE|SORGENIA|ACEA\b|ACQUA\b(?! ?& ?SAPONE)|GAS\b|CONDOMINI|AFFITTO|IKEA|LEROY MERLIN|BRICO|OBI\b|TECNOMAT|FERRAMENTA|MAISONS DU MONDE|JYSK|MONDO CONVENIENZA)/],
  ["telefono",/\b(TELECOM ?ITALIA|TIM\b|VODAFONE|WIND ?TRE|WINDTRE|ILIAD|FASTWEB|HO\.? ?MOBILE|VERY MOBILE|KENA|POSTEMOBILE|SKY WIFI|TISCALI|EOLO)/],
  ["trasporti",/\b(ENI\b|ENILIVE|Q8|IP\b|TAMOIL|ESSO|AGIP|API\b|CARBURANT|DISTRIBUTORE|STAZIONE DI SERVIZIO|AUTOSTRAD|TELEPASS|TRENITALIA|TRENORD|ITALO|ATM\b|BRESCIA MOBILITA|PARCHEGG|EASYPARK|TELEPARK|UBER|FREE ?NOW|TAXI|OFFICINA|GOMMIST|CARROZZERIA|AUTOLAVAGGIO|REVISIONE|BOLLO AUTO|ACI\b)/],
  ["salute",/\b(FARMACI|PARAFARMACI|STUDIO DOTT|DOTT\.|DOTTOR|MEDIC|OSPEDAL|POLIAMBULATORI|ATS\b|ASST\b|TICKET|DENTIST|ODONTOIATR|OTTIC|ANALISI|LABORATORIO|SANITARI|CLINICA|FISIOTERAP)/],
  ["sport",/\b(DECATHLON|PALESTRA|FITNESS|PISCINA|SPORT\b|GYM|CROSSFIT|YOGA|PILATES|PADEL|TENNIS|CENTRO BENESSERE|PARRUCCHIER|BARBIER|ESTETIC)/],
  ["shopping",/\b(AMAZON|AMZN|ZALANDO|MEDIAWORLD|MEDIA WORLD|UNIEURO|EURONICS|EXPERT\b|H ?& ?M|ZARA|PRIMARK|OVS|OVIESSE|BERSHKA|PULL ?& ?BEAR|STRADIVARIUS|CALZEDONIA|INTIMISSIMI|TEZENIS|DOUGLAS|SEPHORA|ACQUA ?& ?SAPONE|TIGOTA|PIUMA|KIKO|FELTRINELLI|MONDADORI|LIBRERIA|EBAY|SHEIN|TEMU|ALIEXPRESS|VINTED|PAYPAL|ORIGINS|CENTRO COMMERCIALE|OUTLET)/],
  ["svago",/\b(NETFLIX|SPOTIFY|DISNEY|PRIME VIDEO|AMAZON PRIME|DAZN|SKY\b|NOW TV|APPLE\.COM|ITUNES|GOOGLE|YOUTUBE|PLAYSTATION|STEAM|NINTENDO|CINEMA|UCI\b|THE SPACE|TEATRO|MUSEO|TICKETONE|VIVATICKET|CONCERT|CLAUDE|ANTHROPIC|OPENAI|CHATGPT|MICROSOFT|AUDIBLE)/],
  ["viaggi",/\b(BOOKING|AIRBNB|EXPEDIA|RYANAIR|EASYJET|WIZZ|ITA AIRWAYS|VOLOTEA|VUELING|LUFTHANSA|HOTEL|ALBERGO|B ?& ?B|RESIDENCE|CAMPEGGIO|CAMPING|AEROPORTO|FLIXBUS|MOBY|TIRRENIA|GRIMALDI)/],
  ["assicurazioni",/\b(GAMALIFE|ASSICURA|GENERALI|ALLIANZ|UNIPOL|AXA\b|ZURICH|REALE MUTUA|CATTOLICA|POSTE ?VITA|VITTORIA|LINEAR|PRIMA ASSICURAZIONI|GENIALLOYD|VERTI|HELVETIA|GROUPAMA)/],
  ["tasse",/\b(F24|AGENZIA DELLE ENTRATE|DELEGHE|PAGOPA|PAGO PA|TARI\b|IMU\b|COMUNE DI|MULTA|SANZIONE)/],
  ["investimenti",/\b(DIRECTA|FINECO|MOGNEY|MONEYFARM|SCALABLE|TRADE REPUBLIC|DEGIRO|XTB|ETORO|BUX\b|FONDO PENSIONE|PREVIDENZA COMPLEMENTARE|PAC\b|ETF\b|TITOLI|SOTTOSCRIZIONE)/],
  ["contanti",/\bPRELIEV/],
  ["rimborsi",/\b(RIMBORSO|STORNO|RESO)\b/]
];
function norm(s){return pulisci(s).toUpperCase();}

// cats = categorie del conto (array), regole = [{testo, categoria}] del conto.
function classifica(m,ctx){
  const {conto,cats,regole}=ctx, ids=ctx.ids||new Set(cats.map(c=>c.id));
  const ok=id=>id&&ids.has(id)?id:null;
  if(ok(m.categoria))return {id:m.categoria,come:"manuale"};
  const d=norm(m.descrizione);
  let best=null;
  for(const r of regole){const t=norm(r.testo);if(t&&d.includes(t)&&ok(r.categoria)&&(!best||t.length>best.testo.length))best={testo:t,categoria:r.categoria};}
  if(best)return {id:best.categoria,come:"regola",regola:best.testo};
  const entrata=m.importo>0;
  const c=CAUSALI[m.causale];
  if(c&&ok(c)&&(c!=="banca"||!entrata))return {id:c,come:"causale"};
  for(const [id,re] of DIZIONARIO){
    if(!re.test(d))continue;
    if(id==="giroconti-auto"){
      const g=conto==="comune"?(entrata?"versamenti":"giroconti"):(entrata?"giroconti":"conto-comune");
      if(ok(g))return {id:g,come:"dizionario"};
      continue;
    }
    if(entrata&&!["rimborsi","investimenti","altre-entrate"].includes(id))continue; // un'entrata da un supermercato è un rimborso, non una spesa
    if(ok(id))return {id,come:"dizionario"};
  }
  if(entrata){
    if(/\b(EMOLUMENT|STIPENDI|COMPENS|PARCELL|FATTURA)/.test(d)&&ok("stipendio"))return {id:"stipendio",come:"dizionario"};
    if(/\b(S\.?R\.?L|S\.?P\.?A|S\.?S\.?D|SOC\.?|ASD|A\.S\.D|SRLS|S\.?N\.?C|S\.?A\.?S|COOPERATIVA|ASSOCIAZIONE)\b|DILETTANT/.test(d)&&/BONIFICO|FAVORE/.test(d)&&ok("stipendio"))return {id:"stipendio",come:"dizionario"};
    return {id:ok("altre-entrate")||cats.find(x=>x.verso==="entrata")?.id||null,come:"predefinita"};
  }
  return {id:ok("da-classificare")||cats.find(x=>x.verso==="uscita")?.id||null,come:"predefinita"};
}

const api={dataISO,numero,leggiRighe,leggiXLS,chiave,confronta,esercente,testoRegola,categoriePredefinite,classifica,norm};
if(typeof module!=="undefined"&&module.exports)module.exports=api; else root.Logica=api;
})(typeof window!=="undefined"?window:globalThis);
