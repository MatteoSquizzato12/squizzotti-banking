/* Dashboard per PC: tanti numeri del conto aperto in una schermata. Usa dati e funzioni di app.js.
   Si vede solo su schermi larghi (voce "Dashboard" del menu). */
const DASH_MQ=matchMedia("(min-width: 1100px)");
const dashOk=()=>DASH_MQ.matches;
DASH_MQ.addEventListener("change",()=>{if(!dashOk()&&S.tab==="dashboard")S.tab="panoramica";if(C0())renderAll();});

// Periodo della dashboard: "12m" = ultimi 12 mesi con dati, oppure un anno ("2026").
function dashMesi(C){
  if(S.dper&&S.dper!=="12m")return mesiTra(S.dper+"-01",S.dper+"-12");
  const fine=C.ultimo||ymOggi();return mesiTra(ymAdd(fine,-11),fine);
}
// Movimenti che contano come entrate/uscite (niente giroconti, investimenti, saldo iniziale), per categoria e mese.
function dashMatrice(C,mesi){
  const set=new Set(mesi),cell={};
  for(const m of C.mov){const k=m.data.slice(0,7);if(!set.has(k))continue;const c=C.byId[m._c.id];if(!c||c.tipo!=="normale"||m._c.id===SALDO)continue;
    (cell[m._c.id]??={})[k]=(cell[m._c.id][k]||0)+m.importo;}
  return cell;
}
// Saldo del conto a fine mese = saldo_base + movimenti della banca fino a quel giorno.
function dashSaldi(C,mesi){
  const base=Number(contoAttivo().saldo_base||0),primo=C.mov.filter(daBanca).reduce((a,m)=>!a||m.data<a?m.data:a,"");
  return mesi.map(k=>{const fine=k+"-31";if(!primo||fine<primo)return null;return base+sommaBanca(C,fine);});
}

function vDashboard(C){
  if(!C.mov.length)return nessunDato(C);
  const mesi=dashMesi(C),T=totali(C.mov.filter(m=>mesi.includes(m.data.slice(0,7))),C),x=saldi(C);
  const anni=[...new Set(C.mov.map(m=>m.data.slice(0,4)))].sort();
  const pv=C.mov.filter(m=>mesi.includes(m.data.slice(0,7))&&(m._c.id==="polizza-vita"||radice(m._c.id)==="polizza-vita")).reduce((s,m)=>s-m.importo,0);
  let h=`<div class="toolbar"><div class="chipline" role="group" aria-label="Periodo"><button class="pchip" data-act="d-per" data-v="12m" aria-pressed="${!S.dper||S.dper==="12m"}">Ultimi 12 mesi</button>${anni.map(y=>`<button class="pchip" data-act="d-per" data-v="${y}" aria-pressed="${S.dper===y}">${y}</button>`).join("")}</div>
    <p class="meta grow" style="text-align:right">${ymNome(mesi[0])} – ${ymNome(mesi[mesi.length-1])}</p></div>`;
  const quota=T.e>0?Math.round(T.r/T.e*100):null;
  h+=`<div class="dkpis">
    <div class="kpi"><div class="k"><i class="key in"></i>Entrate</div><div class="v num">${T.e>0.004?"+":""}${eur(T.e)}</div></div>
    <div class="kpi"><div class="k"><i class="key out"></i>Uscite</div><div class="v num">${T.u>0.004?"−":""}${eur(T.u)}</div></div>
    <div class="kpi hero"><div class="k">Risparmio</div><div class="v num">${eurS(T.r)}</div><div class="d">${quota==null?"&nbsp;":quota+"% delle entrate"}</div></div>
    ${pv>0.004?`<div class="kpi"><div class="k">Polizza vita</div><div class="v num">${eur(pv)}</div></div>`:""}
    <div class="kpi"><div class="k">Saldo conto corrente</div><div class="v num">${eur(x.banca)}</div><div class="d">${x.al?"al "+giorno(x.al):""}</div></div>
  </div>`;
  h+=`<div class="dgrid2">
    <div class="card"><div class="card-head"><h2>Entrate, uscite e risparmio</h2><div class="legend"><span><i class="key in"></i>Entrate</span><span><i class="key out"></i>Uscite</span><span><i class="lkey ri"></i>Risparmio</span></div></div><div class="chart" id="d-and"></div></div>
    <div class="card"><div class="card-head"><h2>Saldo del conto a fine mese</h2></div><div class="chart" id="d-saldo"></div></div>
  </div>`;
  h+=dashTabella(C,mesi);
  const agg={};for(const [id,v] of Object.entries(T.net)){const r=radice(id);agg[r]=(agg[r]||0)+v;}
  h+=cardTorta(Object.entries(agg).filter(([,v])=>v<-0.004).map(([id,v])=>[id,-v]).sort((a,b)=>b[1]-a[1]),T.u);
  return h;
}

/* ---------- categorie × mesi ---------- */
// Righe: categorie principali di uscita (con le sottocategorie sotto), colonne: mesi + totale + media.
// Colore della cella: una sola tinta, più scura = più spesa (6 gradini, scala a radice quadrata).
function dashTabella(C,mesi){
  const cell=dashMatrice(C,mesi),u=(id,k)=>-(cell[id]?.[k]||0);
  const rows=[];
  for(const c of C.cats.filter(c=>!c.padre&&c.tipo==="normale"&&c.verso==="uscita")){
    const fs=C.cats.filter(x=>x.padre===c.id),ids=[c.id,...fs.map(f=>f.id)];
    const vals=mesi.map(k=>ids.reduce((s,id)=>s+u(id,k),0)),tot=vals.reduce((a,b)=>a+b,0);
    if(Math.abs(tot)<0.005)continue;
    const sub=fs.map(f=>{const v=mesi.map(k=>u(f.id,k));return {id:f.id,nome:f.nome,vals:v,tot:v.reduce((a,b)=>a+b,0),figlia:true,figli:[]};}).filter(r=>Math.abs(r.tot)>=0.005);
    const proprio=mesi.reduce((s,k)=>s+u(c.id,k),0); // movimenti messi nella principale, senza sottocategoria
    if(sub.length&&Math.abs(proprio)>=0.005)sub.push({id:c.id,nome:"Senza sottocategoria",vals:mesi.map(k=>u(c.id,k)),tot:proprio,figlia:true,figli:[]});
    rows.push({id:c.id,nome:c.nome,vals,tot,figli:sub});
  }
  if(!rows.length)return `<div class="card" style="margin-bottom:14px"><h2>Uscite per categoria e mese</h2><p class="meta">Nessuna uscita nel periodo.</p></div>`;
  rows.sort((a,b)=>b.tot-a.tot);
  const max=Math.max(...rows.flatMap(r=>[...r.vals,...r.figli.flatMap(s=>s.vals)]),1);
  // scala a radice quadrata: una spesa enorme (es. un F24) non schiaccia tutte le altre sul colore più chiaro
  const liv=v=>v<=0.004?0:Math.min(6,1+Math.floor(Math.sqrt(v/max)*6*0.9999));
  const td=(id,k,v)=>`<td class="hc h${liv(v)}"><button data-act="d-cella" data-cat="${esc(id)}" data-ym="${k}" title="${esc(nomeCat(id))} · ${ymNome(k)}: ${eur(v)}">${Math.abs(v)<0.005?"":compatto(v)}</button></td>`;
  const riga=(r,cls)=>`<tr class="${cls}"><th scope="row"><button data-act="d-cella" data-cat="${esc(r.id)}" data-ym="">${r.figlia?"↳ ":""}${esc(r.nome)}</button></th>${r.vals.map((v,i)=>td(r.id,mesi[i],v)).join("")}<td class="tt num">${eur(r.tot)}</td><td class="tt num">${eur(r.tot/mesi.length)}</td></tr>`;
  const totM=mesi.map((k,i)=>rows.reduce((s,r)=>s+r.vals[i],0)),totT=totM.reduce((a,b)=>a+b,0);
  return `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Uscite per categoria e mese</h2><p class="meta">più scuro = più speso · clic su una cella per i movimenti</p></div>
  <div class="hwrap"><table class="heat num"><thead><tr><th></th>${mesi.map(k=>`<th scope="col">${MESI3[+k.slice(5)-1]}${k.endsWith("-01")||k===mesi[0]?" "+k.slice(2,4):""}</th>`).join("")}<th scope="col">Totale</th><th scope="col">Media</th></tr></thead>
  <tbody>${rows.map(r=>riga(r,"")+r.figli.map(s=>riga(s,"sub")).join("")).join("")}</tbody>
  <tfoot><tr><th scope="row">Totale uscite</th>${totM.map(v=>`<td>${compatto(v)}</td>`).join("")}<td class="tt">${eur(totT)}</td><td class="tt">${eur(totT/mesi.length)}</td></tr></tfoot></table></div></div>`;
}

/* ---------- grafici ---------- */
// Colonne entrate/uscite (≤24px, angoli tondi in cima, 2px tra le due) + linea del risparmio, stessa scala in euro.
function dashScala(min,max){
  const span=Math.max(1,max-min),passo=Math.pow(10,Math.floor(Math.log10(span/4))),st=[1,2,2.5,5,10].map(x=>x*passo).find(x=>x*4>=span)||passo*10;
  const lo=Math.floor(min/st)*st,hi=Math.ceil(max/st)*st||st;const ticks=[];for(let v=lo;v<=hi+1e-9;v+=st)ticks.push(v);return {lo,hi,ticks};
}
function disegnaDashboard(){
  const C=C0();if(S.tab!=="dashboard"||!C)return;
  const mesi=dashMesi(C),vals=mesi.map(k=>C.tot[k]||{e:0,u:0,r:0});
  // 1) entrate, uscite, risparmio
  let el=$("d-and");
  if(el){
    const W=Math.max(320,el.clientWidth),H=240,pl=48,pb=26,pt=10,ih=H-pb-pt;
    const sc=dashScala(Math.min(0,...vals.map(v=>v.r)),Math.max(1,...vals.map(v=>Math.max(v.e,v.u,v.r)))),y=v=>pt+ih-(v-sc.lo)/(sc.hi-sc.lo)*ih,y0=y(0);
    const bw=(W-pl)/mesi.length,bar=Math.max(4,Math.min(24,(bw-12)/2));
    const col=(x,v,cls)=>{if(v<=0)return "";const top=y(v),h=y0-top,r=Math.min(4,h);return `<path class="${cls}" d="M${x},${y0}V${top+r}Q${x},${top} ${x+r},${top}H${x+bar-r}Q${x+bar},${top} ${x+bar},${top+r}V${y0}Z"/>`;};
    let s=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Entrate, uscite e risparmio per mese">`;
    for(const v of sc.ticks)s+=`<line class="${v===0?"base":"gl"}" x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="tick num" x="${pl-8}" y="${y(v)+4}" text-anchor="end">${compatto(v)}</text>`;
    const pts=[];
    mesi.forEach((k,i)=>{const cx=pl+i*bw+bw/2;s+=col(cx-bar-1,vals[i].e,"bin")+col(cx+1,vals[i].u,"bout");pts.push([cx,y(vals[i].r)]);
      s+=`<text class="tick" x="${cx}" y="${H-8}" text-anchor="middle">${MESI3[+k.slice(5)-1]}</text>`;});
    s+=`<path class="lri" d="M${pts.map(p=>p.join(",")).join("L")}"/>`+pts.map(p=>`<circle class="dri" cx="${p[0]}" cy="${p[1]}" r="4"/>`).join("");
    s+=`<line class="cross" id="d-cross" x1="0" x2="0" y1="${pt}" y2="${pt+ih}" visibility="hidden"/>`;
    mesi.forEach((k,i)=>s+=`<rect class="hit" x="${pl+i*bw}" y="${pt}" width="${bw}" height="${ih+pb}" data-i="${i}"/>`);
    el.innerHTML=s+"</svg>";
    el.onmousemove=e=>{const r=e.target.closest("[data-i]");if(!r){nascondiTip();$("d-cross")?.setAttribute("visibility","hidden");return;}const i=+r.dataset.i,v=vals[i],cr=$("d-cross");
      cr.setAttribute("x1",pts[i][0]);cr.setAttribute("x2",pts[i][0]);cr.setAttribute("visibility","visible");
      mostraTip(e,`<b>${ymNome(mesi[i])}</b><div><span><i class="key in"></i>Entrate</span><span class="num">${eur(v.e)}</span></div><div><span><i class="key out"></i>Uscite</span><span class="num">${eur(v.u)}</span></div><div><span><i class="lkey ri"></i>Risparmio</span><span class="num">${eurS(v.r)}</span></div>`);};
    el.onmouseleave=()=>{nascondiTip();$("d-cross")?.setAttribute("visibility","hidden");};
  }
  // 2) saldo a fine mese
  el=$("d-saldo");
  if(el){
    const sal=dashSaldi(C,mesi),ok=sal.filter(v=>v!=null);
    if(!ok.length){el.innerHTML=`<p class="meta">Nessun movimento della banca nel periodo.</p>`;return;}
    const W=Math.max(320,el.clientWidth),H=240,pl=56,pb=26,pt=10,ih=H-pb-pt;
    const sc=dashScala(Math.min(0,...ok),Math.max(...ok)),y=v=>pt+ih-(v-sc.lo)/(sc.hi-sc.lo)*ih,bw=(W-pl)/mesi.length;
    let s=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Saldo del conto a fine mese">`;
    for(const v of sc.ticks)s+=`<line class="${v===0?"base":"gl"}" x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="tick num" x="${pl-8}" y="${y(v)+4}" text-anchor="end">${compatto(v)}</text>`;
    const pts=sal.map((v,i)=>v==null?null:[pl+i*bw+bw/2,y(v)]),val=pts.filter(Boolean);
    s+=`<path class="asal" d="M${val[0][0]},${y(Math.max(sc.lo,0))}L${val.map(p=>p.join(",")).join("L")}L${val[val.length-1][0]},${y(Math.max(sc.lo,0))}Z"/>`;
    s+=`<path class="lsal" d="M${val.map(p=>p.join(",")).join("L")}"/>`+val.map(p=>`<circle class="dsal" cx="${p[0]}" cy="${p[1]}" r="4"/>`).join("");
    const last=val[val.length-1],lv=sal.filter(v=>v!=null).pop();
    s+=`<text class="tick sel" x="${Math.min(last[0],W-4)}" y="${last[1]-10}" text-anchor="end">${eur(lv)}</text>`;
    mesi.forEach((k,i)=>s+=`<text class="tick" x="${pl+i*bw+bw/2}" y="${H-8}" text-anchor="middle">${MESI3[+k.slice(5)-1]}</text><rect class="hit" x="${pl+i*bw}" y="${pt}" width="${bw}" height="${ih+pb}" data-i="${i}"/>`);
    el.innerHTML=s+"</svg>";
    el.onmousemove=e=>{const r=e.target.closest("[data-i]");if(!r||sal[+r.dataset.i]==null){nascondiTip();return;}const i=+r.dataset.i;
      mostraTip(e,`<b>${ymNome(mesi[i])}</b><div><span>Saldo a fine mese</span><span class="num">${eur(sal[i])}</span></div>`);};
    el.onmouseleave=nascondiTip;
  }
}

/* ---------- eventi della dashboard ---------- */
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-act]");if(!b||!C0())return;const a=b.dataset.act;
  if(a==="d-per"){S.dper=b.dataset.v;renderMain();}
  else if(a==="d-cella"){ // apre i movimenti di quella categoria (e mese, se è una cella)
    S.tab="movimenti";S.filtri={...filtriVuoti(),cats:[b.dataset.cat]};S.verso="tutti";S.q="";
    if(b.dataset.ym){S.per="mese";S.mese=b.dataset.ym;}else if(S.dper&&S.dper!=="12m"){S.per="anno";S.mese=S.dper+S.mese.slice(4);}else S.per="tutto";
    nascondiTip();renderAll();scrollTo({top:0});
  }
});
