/* Logica senza interfaccia: chiave anti-duplicati, esercente, categorie predefinite e classificazione.
   Funziona nel browser e in Node (per i test). I movimenti arrivano dalla banca: supabase/functions/banca. */
(function(root){
"use strict";

// Importi scritti a mano: "1.234,56", "12,5", "€ 30".
function numero(v){
  if(v==null||v==="")return null;
  if(typeof v==="number")return v;
  let s=String(v).replace(/[€\s]/g,"");
  if(/,\d{1,2}$/.test(s))s=s.replace(/\./g,"").replace(",","."); // 1.234,56
  const n=parseFloat(s);
  return isNaN(n)?null:n;
}
const pulisci=s=>String(s==null?"":s).replace(/\s+/g," ").trim();

/* ---------- carta prepagata: Excel di Nexi ---------- */
// Foglio «Movimenti conto»: una riga «Movimenti Carta **** **** **** 1234», poi l'intestazione
// Mese | Data | Riferimento | Categorie | Descrizione | Stato | Importo originale in Divisa | Divisa | Importo (€) | …
// Le righe «Non Contabilizzato» si saltano: tornano nel file del mese dopo, con il loro riferimento.
// Le ricariche («RICARICA DA HOMEBANKING») non hanno riferimento: la chiave le distingue per data e importo.
function dataNexi(v){
  if(typeof v==="number")return new Date(Math.round((v-25569)*864e5)).toISOString().slice(0,10); // data Excel
  const m=String(v==null?"":v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m?m[3]+"-"+m[2].padStart(2,"0")+"-"+m[1].padStart(2,"0"):null;
}
function leggiPrepagata(righe){
  let carta=null,h=-1,col=null;
  for(let i=0;i<Math.min(righe.length,40);i++){
    const r=(righe[i]||[]).map(c=>pulisci(c)),trova=re=>r.findIndex(x=>re.test(x));
    const m=r.join(" ").match(/Carta[\s*]+(\d{4})\b/i);if(m&&!carta)carta=m[1];
    const c={data:trova(/^data$/i),descr:trova(/^descrizione$/i),imp:trova(/^importo\s*\(€\)$/i),rif:trova(/^riferimento$/i),stato:trova(/^stato$/i)};
    if(c.data>=0&&c.descr>=0&&c.imp>=0){h=i;col=c;break;}
  }
  if(h<0)throw new Error("Non trovo le colonne dei movimenti (Data, Descrizione, Importo). È l'Excel della prepagata scaricato da Nexi?");
  const movimenti=[],esclusi=[];
  for(const r of righe.slice(h+1)){
    if(!r||r.every(c=>c==null||c===""))continue;
    const data=dataNexi(r[col.data]),importo=numero(r[col.imp]),descrizione=pulisci(r[col.descr]);
    if(!data||importo==null||!importo||!descrizione)continue;
    const m={data,valuta:data,importo:Math.round(importo*100)/100,causale:"CARTA",descrizione};
    if(col.stato>=0&&/non\s+contabilizzat/i.test(pulisci(r[col.stato]))){esclusi.push(m);continue;}
    m.chiave=[data,"CARTA",m.importo.toFixed(2),descrizione.toUpperCase(),col.rif>=0?pulisci(r[col.rif]):""].join("|");
    movimenti.push(m);
  }
  return {carta,movimenti,esclusi};
}

/* ---------- duplicati ---------- */
// Stesso giorno + stessa causale + stesso importo + stessa descrizione = stesso movimento.
// La funzione "banca" calcola la stessa chiave: i movimenti già importati dagli XLS sono riconosciuti.
function chiave(m){return [m.data,(m.causale||"").toUpperCase(),Number(m.importo).toFixed(2),pulisci(m.descrizione).toUpperCase()].join("|");}

/* ---------- esercente / controparte ---------- */
const TAGLIA=s=>pulisci(s).replace(/[.\s-]+$/,"");
function esercente(m){
  const d=pulisci(m.descrizione);
  if(m.causale==="CONTANTI"||m.causale==="RETTIFICA")return d||"Movimento a mano"; // scritto a mano: la descrizione è già il nome
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
// [id, nome, tipo, verso, padre]. Le sottocategorie hanno un "padre": nei totali confluiscono nella categoria principale.
// Il conto comune ha "Versamenti di Matteo e Anna" al posto di "Conto comune".
const BASE=[
  ["spesa","Spese alimentari","normale","uscita"],
  ["ristoranti","Ristoranti","normale","uscita"],
  ["casa","Casa e utenze","normale","uscita"],
  ["auto","Auto","normale","uscita"],
  ["benzina","Benzina","normale","uscita","auto"],
  ["tagliando-revisione","Tagliando e revisione","normale","uscita","auto"],
  ["straordinarie-auto","Straordinarie auto","normale","uscita","auto"],
  ["salute","Salute","normale","uscita"],
  ["shopping","Shopping","normale","uscita"],
  ["viaggi","Viaggi","normale","uscita"],
  ["assicurazioni","Assicurazioni","normale","uscita"],
  ["abbonamenti","Abbonamenti","normale","uscita"],
  ["tasse","Tasse e F24","normale","uscita"],
  ["banca","Commissioni e bolli","normale","uscita"],
  ["contanti","Prelievi contanti","normale","uscita"],
  ["prepagata","Ricarica prepagata","normale","uscita"],
  ["regali","Regali e famiglia","normale","uscita"],
  ["conto-comune","Conto comune","normale","uscita"],
  ["commercialista","Commercialista","normale","uscita"],
  ["da-classificare","Da classificare","normale","uscita"],
  ["stipendio","Stipendio e compensi","normale","entrata"],
  ["versamenti","Versamenti di Matteo e Anna","normale","entrata"],
  ["rimborsi","Rimborsi","normale","entrata"],
  ["altre-entrate","Altre entrate","normale","entrata"],
  ["giroconti","Giroconti tra conti propri","trasferimento","uscita"],
  ["investimenti","Investimenti","investimento","uscita"],
  ["polizza-vita","Polizza vita","investimento","uscita"],
  ["saldo-iniziale","Saldo iniziale (dal vecchio conto)","trasferimento","entrata"]
];
function categoriePredefinite(conto){
  return BASE.filter(([id])=>conto==="comune"?id!=="conto-comune":id!=="versamenti")
    .map(([id,nome,tipo,verso,padre],i)=>({conto,id,nome,tipo,verso,padre:padre||null,ordine:i}));
}
// Prima versione delle categorie (19/10/2026): categoria vecchia → nuova, per aggiornare movimenti e regole.
const MIGRAZIONE_V2={"telefono":"casa","trasporti":"auto","sport":"shopping","svago":"abbonamenti","altre-uscite":"da-classificare"};

/* ---------- classificazione ---------- */
// 1) scelta a mano sul movimento  2) regole imparate (la più lunga vince)  3) causale della banca
// 4) dizionario di esercenti italiani  5) "Da classificare" (uscite) o "Altre entrate" (entrate).
// Nel dizionario si prova la prima categoria esistente della lista (es. "benzina", se è stata eliminata "auto").
const CAUSALI={"EB":"banca","5E":"banca","0F":"banca","2J":"banca","18":"banca","4Y":"banca","4K":"banca","2U":"prepagata","FT":"tasse","(0":"contanti","B8":"stipendio"};
const DIZIONARIO=[
  [["giroconti-auto"],/\bGIROCONTO\b/],
  [["spesa"],/\b(ESSELUNGA|CONAD|COOP|CARREFOUR|LIDL|EUROSPIN|IPER\b|IPERCOOP|FAMILA|PAM\b|DESPAR|INTERSPAR|EUROSPAR|SPAR\b|MD\s+S\.?P\.?A|ALDI|PENNY|BENNET|TIGROS|SIGMA|CRAI|TODIS|IN'S|SUPERMERCAT|ALIMENTARI|MACELLERIA|PANIFICIO|PANETTERIA|FORNO|FRUTTA|ORTOFRUTTA|PESCHERIA|GASTRONOMIA|SALUMERIA|CASEIFICIO|MERCATO)/],
  [["ristoranti"],/\b(MC ?DONALD|BURGER ?KING|KFC|RISTORANT|PIZZ|TRATTORIA|OSTERIA|LOCANDA|AGRITURISMO|BAR\b|CAFF|CAFE\b|CREMERIA|GELAT|PASTICCERIA|SUSHI|KEBAB|BIRRERIA|PUB\b|ENOTECA|TAVOLA CALDA|ROSTICCERIA|DELIVEROO|JUST ?EAT|GLOVO|AUTOGRILL|CHEF EXPRESS|STARBUCKS|BISTROT)/],
  [["casa"],/\b(A2A|ENEL\b|ENEL ENERGIA|HERA\b|IREN\b|EDISON|PLENITUDE|SORGENIA|ACEA\b|ACQUA\b(?! ?& ?SAPONE)|GAS\b|CONDOMINI|AFFITTO|IKEA|LEROY MERLIN|BRICO|OBI\b|TECNOMAT|FERRAMENTA|MAISONS DU MONDE|JYSK|MONDO CONVENIENZA|TELECOM ?ITALIA|TIM\b|VODAFONE|WIND ?TRE|WINDTRE|ILIAD|FASTWEB|HO\.? ?MOBILE|VERY MOBILE|KENA|POSTEMOBILE|SKY WIFI|TISCALI|EOLO)/],
  [["benzina","auto"],/\b(ENI\b|ENILIVE|Q8|IP\b|TAMOIL|ESSO|AGIP|API\b|CARBURANT|DISTRIBUTORE|STAZIONE DI SERVIZIO|STAZ\.? SERV)/],
  [["tagliando-revisione","auto"],/\b(OFFICINA|AUTOFFICINA|GOMMIST|PNEUMATIC|REVISIONE|TAGLIANDO|MOTORIZZAZIONE)/],
  [["straordinarie-auto","auto"],/\b(CARROZZERIA|SOCCORSO STRADALE|CARRO ATTREZZI|AUTORICAMBI|RICAMBI AUTO)/],
  [["auto"],/\b(AUTOSTRAD|TELEPASS|PARCHEGG|EASYPARK|TELEPARK|AUTOLAVAGGIO|BOLLO AUTO|ACI\b)/],
  [["viaggi"],/\b(TRENITALIA|TRENORD|ITALO|ATM\b|BRESCIA MOBILITA|UBER|FREE ?NOW|TAXI|BOOKING|AIRBNB|EXPEDIA|RYANAIR|EASYJET|WIZZ|ITA AIRWAYS|VOLOTEA|VUELING|LUFTHANSA|HOTEL|ALBERGO|B ?& ?B|RESIDENCE|CAMPEGGIO|CAMPING|AEROPORTO|FLIXBUS|MOBY|TIRRENIA|GRIMALDI)/],
  [["salute"],/\b(FARMACI|PARAFARMACI|STUDIO DOTT|DOTT\.|DOTTOR|MEDIC|OSPEDAL|POLIAMBULATORI|ATS\b|ASST\b|TICKET|DENTIST|ODONTOIATR|OTTIC|ANALISI|LABORATORIO|SANITARI|CLINICA|FISIOTERAP)/],
  [["abbonamenti"],/\b(NETFLIX|SPOTIFY|DISNEY|PRIME VIDEO|AMAZON PRIME|DAZN|SKY\b|NOW TV|APPLE\.COM|ITUNES|GOOGLE|YOUTUBE|PLAYSTATION|AUDIBLE|CLAUDE|ANTHROPIC|OPENAI|CHATGPT|MICROSOFT|PALESTRA|FITNESS|PISCINA|GYM|CROSSFIT|YOGA|PILATES)/],
  [["shopping"],/\b(AMAZON|AMZN|ZALANDO|MEDIAWORLD|MEDIA WORLD|UNIEURO|EURONICS|EXPERT\b|H ?& ?M|ZARA|PRIMARK|OVS|OVIESSE|BERSHKA|PULL ?& ?BEAR|STRADIVARIUS|CALZEDONIA|INTIMISSIMI|TEZENIS|DOUGLAS|SEPHORA|ACQUA ?& ?SAPONE|TIGOTA|PIUMA|KIKO|FELTRINELLI|MONDADORI|LIBRERIA|EBAY|SHEIN|TEMU|ALIEXPRESS|VINTED|PAYPAL|ORIGINS|CENTRO COMMERCIALE|OUTLET|DECATHLON|CISALFA|PARRUCCHIER|BARBIER|ESTETIC)/],
  [["polizza-vita","assicurazioni"],/\b(GAMALIFE|POLIZZA VITA)/],
  [["assicurazioni"],/\b(ASSICURA|GENERALI|ALLIANZ|UNIPOL|AXA\b|ZURICH|REALE MUTUA|CATTOLICA|POSTE ?VITA|VITTORIA|LINEAR|PRIMA ASSICURAZIONI|GENIALLOYD|VERTI|HELVETIA|GROUPAMA)/],
  [["commercialista"],/\b(COMMERCIALIST|STUDIO COMMERCIALE|CONSULENTE DEL LAVORO|CONSULTING|CAF\b|PATRONATO)/],
  [["tasse"],/\b(F24|AGENZIA DELLE ENTRATE|DELEGHE|PAGOPA|PAGO PA|TARI\b|IMU\b|COMUNE DI|MULTA|SANZIONE)/],
  [["investimenti"],/\b(DIRECTA|FINECO|MOGNEY|MONEYFARM|SCALABLE|TRADE REPUBLIC|DEGIRO|XTB|ETORO|BUX\b|FONDO PENSIONE|PREVIDENZA COMPLEMENTARE|PAC\b|ETF\b|TITOLI|SOTTOSCRIZIONE)/],
  [["contanti"],/\bPRELIEV/],
  [["rimborsi"],/\b(RIMBORSO|STORNO|RESO)\b/]
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
  // Sulla carta prepagata (NEXI) la ricarica arriva come entrata: è lo stesso giroconto della ricarica partita dal conto.
  if(m.causale==="CARTA"&&entrata&&/RICARIC/.test(d)&&ok("prepagata"))return {id:"prepagata",come:"causale"};
  const c=CAUSALI[m.causale];
  if(c&&ok(c)&&(c!=="banca"||!entrata))return {id:c,come:"causale"};
  for(const [lista,re] of DIZIONARIO){
    if(!re.test(d))continue;
    if(lista[0]==="giroconti-auto"){
      const g=conto==="comune"?(entrata?"versamenti":"giroconti"):(entrata?"giroconti":"conto-comune");
      if(ok(g))return {id:g,come:"dizionario"};
      continue;
    }
    if(entrata&&!["rimborsi","investimenti","altre-entrate"].includes(lista[0]))continue; // un'entrata da un supermercato è un rimborso, non una spesa
    const id=lista.find(ok);
    if(id)return {id,come:"dizionario"};
  }
  if(entrata){
    if(/\b(EMOLUMENT|STIPENDI|COMPENS|PARCELL|FATTURA)/.test(d)&&ok("stipendio"))return {id:"stipendio",come:"dizionario"};
    if(/\b(S\.?R\.?L|S\.?P\.?A|S\.?S\.?D|SOC\.?|ASD|A\.S\.D|SRLS|S\.?N\.?C|S\.?A\.?S|COOPERATIVA|ASSOCIAZIONE)\b|DILETTANT/.test(d)&&/BONIFICO|FAVORE/.test(d)&&ok("stipendio"))return {id:"stipendio",come:"dizionario"};
    return {id:ok("altre-entrate")||cats.find(x=>x.verso==="entrata")?.id||null,come:"predefinita"};
  }
  return {id:ok("da-classificare")||cats.find(x=>x.verso==="uscita")?.id||null,come:"predefinita"};
}

const api={numero,chiave,leggiPrepagata,esercente,testoRegola,categoriePredefinite,MIGRAZIONE_V2,classifica,norm};
if(typeof module!=="undefined"&&module.exports)module.exports=api; else root.Logica=api;
})(typeof window!=="undefined"?window:globalThis);
