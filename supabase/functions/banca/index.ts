// Squizzotti's Banking: collegamento con Banca Valsabbina tramite Enable Banking (PSD2, sola lettura).
// La chiave privata dell'applicazione Enable Banking sta solo nei secret di Supabase (EB_APP_ID, EB_PRIVATE_KEY):
// mai nel repository, mai nel browser. Pubblicazione: npx supabase functions deploy banca --no-verify-jwt
//
// Azioni (corpo JSON {azione, ...}):
//   avvia            → link alla pagina della banca per dare il consenso
//   conferma         → al ritorno dalla banca: apre la sessione e restituisce i conti visti nel consenso
//   abbina           → lega ogni conto della banca a un conto dell'app e scarica subito i movimenti
//   aggiorna         → scarica i movimenti nuovi dei conti collegati che l'utente vede
//   scollega         → toglie il collegamento di un conto
//   cron             → aggiornamento automatico di tutti i conti (chiamato da pg_cron con l'header x-cron)
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const EB = "https://api.enablebanking.com";
const APP_URL = "https://matteosquizzato12.github.io/squizzotti-banking/";
const BANCA = { name: "Banca Valsabbina", country: "IT" };
const MANUALI = ["CONTANTI", "RETTIFICA"]; // movimenti scritti a mano: non vengono dalla banca
const GIORNO = 864e5;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

/* ---------- Enable Banking ---------- */
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let chiave: Promise<CryptoKey> | null = null;
function chiavePrivata() {
  return chiave ??= (() => {
    const pem = Deno.env.get("EB_PRIVATE_KEY")!.replace(/-----[^-]+-----|\s/g, "");
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  })();
}
async function jwt() {
  const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const dati = enc({ typ: "JWT", alg: "RS256", kid: Deno.env.get("EB_APP_ID") }) + "." +
    enc({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 });
  const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await chiavePrivata(), new TextEncoder().encode(dati));
  return dati + "." + b64u(firma);
}
class ErroreBanca extends Error {
  constructor(public status: number, public dettaglio: Record<string, unknown>) {
    super(String(dettaglio.message || dettaglio.error || "Errore della banca (" + status + ")"));
  }
  get scaduto() {
    return this.status === 401 || /EXPIRED|SESSION|CONSENT/i.test(String(this.dettaglio.error || ""));
  }
}
// ip = indirizzo di chi usa l'app: va passato quando la persona è presente (altrimenti la banca conta l'accesso
// come automatico, massimo 4 al giorno).
async function eb(metodo: string, percorso: string, corpo?: unknown, ip?: string) {
  const h: Record<string, string> = { Authorization: "Bearer " + await jwt(), "Content-Type": "application/json" };
  if (ip) h["psu-ip-address"] = ip;
  const r = await fetch(EB + percorso, { method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroreBanca(r.status, j);
  return j;
}

/* ---------- movimenti ---------- */
const pulisci = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
type Mov = { data: string; valuta: string | null; importo: number; causale: string; descrizione: string; chiave: string };
// Stessa forma delle righe dell'XLS: la causale Valsabbina arriva come riga "Causale Movimento: XX", la descrizione
// è il resto unito da spazi. Così la chiave anti-duplicati coincide con quella di js/logica.js (verificato riga per riga).
// deno-lint-ignore no-explicit-any
function movimento(t: any): Mov {
  const righe: string[] = t.remittance_information || [];
  const c = righe.find((r) => /^Causale Movimento:/i.test(r));
  const causale = c ? c.replace(/^Causale Movimento:\s*/i, "").trim() : "";
  const descrizione = pulisci(righe.filter((r) => r !== c).join(" ")) || "Movimento senza descrizione";
  const importo = Math.round(Math.abs(Number(t.transaction_amount.amount)) * 100) / 100 *
    (t.credit_debit_indicator === "DBIT" ? -1 : 1);
  const data = t.booking_date || t.value_date;
  return {
    data, valuta: t.value_date || null, importo, causale, descrizione,
    chiave: [data, causale.toUpperCase(), importo.toFixed(2), descrizione.toUpperCase()].join("|"),
  };
}
// deno-lint-ignore no-explicit-any
async function tutte(q: () => any) {
  const out = [];
  for (let da = 0;; da += 1000) {
    const { data, error } = await q().range(da, da + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Collegamento = { conto: string; sessione: string; account_uid: string; scade: string };
// Scarica i movimenti nuovi di un conto, li salva senza doppioni e allinea il saldo a quello della banca.
async function sincronizza(c: Collegamento, chi: string | null, ip?: string) {
  try {
    // Si riparte da 10 giorni prima dell'ultimo movimento salvato (la banca a volte contabilizza in ritardo).
    // Dopo la prima ora dal consenso la banca dà solo gli ultimi 90 giorni. Conto vuoto: tutto lo storico disponibile.
    const { data: ult, error: e1 } = await db.from("movimenti").select("data").eq("conto", c.conto)
      .not("causale", "in", `(${MANUALI.join(",")})`).order("data", { ascending: false }).limit(1);
    if (e1) throw e1;
    let dal: string | null = null;
    if (ult.length) {
      const d = new Date(ult[0].data + "T00:00:00Z").getTime() - 10 * GIORNO;
      dal = iso(new Date(Math.max(d, Date.now() - 89 * GIORNO)));
    }
    // deno-lint-ignore no-explicit-any
    const righe: any[] = [];
    let ck: string | undefined;
    do {
      const q = new URLSearchParams(dal ? { date_from: dal } : { strategy: "longest" });
      if (ck) q.set("continuation_key", ck);
      const r = await eb("GET", `/accounts/${c.account_uid}/transactions?${q}`, undefined, ip);
      righe.push(...(r.transactions || []));
      ck = r.continuation_key || undefined;
    } while (ck);
    const banca = righe.filter((t) => !t.status || t.status === "BOOK").map(movimento).filter((m) => m.data);

    // Doppioni: stessa chiave = stesso movimento, contando quante volte compare (8 caffè da 1 € nello stesso giorno
    // sono 8 movimenti veri). Entra solo la differenza tra le righe della banca e quelle già salvate.
    let nuovi: Mov[] = [];
    if (banca.length) {
      const da = banca.reduce((a, m) => (m.data < a ? m.data : a), banca[0].data);
      const salvati = await tutte(() => db.from("movimenti").select("chiave").eq("conto", c.conto).gte("data", da));
      const quanti = new Map<string, number>();
      for (const r of salvati) quanti.set(r.chiave, (quanti.get(r.chiave) || 0) + 1);
      for (const m of banca) {
        const n = quanti.get(m.chiave) || 0;
        if (n) quanti.set(m.chiave, n - 1);
        else nuovi.push(m);
      }
    }
    if (nuovi.length) {
      const date = nuovi.map((m) => m.data).sort();
      const { data: imp, error } = await db.from("importazioni").insert({
        conto: c.conto, nome_file: "Collegamento banca", dal: date[0], al: date[date.length - 1],
        righe_file: banca.length, righe_importate: nuovi.length, righe_duplicate: banca.length - nuovi.length,
        caricato_da: chi,
      }).select("id").single();
      if (error) throw error;
      for (let i = 0; i < nuovi.length; i += 500) {
        const { error: e } = await db.from("movimenti")
          .insert(nuovi.slice(i, i + 500).map((m) => ({ ...m, conto: c.conto, importazione: imp.id })));
        if (e) {
          await db.from("importazioni").delete().eq("id", imp.id); // niente importazioni zoppe
          throw e;
        }
      }
    }

    // Saldo: quello della banca. saldo_base = saldo − somma dei movimenti della banca salvati, così l'app
    // (che calcola saldo_base + movimenti, anche mese per mese) mostra lo stesso numero dell'home banking.
    const b = await eb("GET", `/accounts/${c.account_uid}/balances`, undefined, ip);
    // deno-lint-ignore no-explicit-any
    const saldi: any[] = b.balances || [];
    const s = ["CLBD", "ITBD", "XPCD", "ITAV", "CLAV"].map((t) => saldi.find((x) => x.balance_type === t)).find(Boolean) ||
      saldi[0];
    let saldo = null;
    if (s) {
      saldo = Math.abs(Number(s.balance_amount.amount)) * (s.credit_debit_indicator === "DBIT" || Number(s.balance_amount.amount) < 0 ? -1 : 1);
      const tutti = await tutte(() =>
        db.from("movimenti").select("importo").eq("conto", c.conto).not("causale", "in", `(${MANUALI.join(",")})`)
      );
      const somma = tutti.reduce((x, m) => x + Number(m.importo), 0);
      const { error } = await db.from("conti").update({
        saldo_base: Math.round((saldo - somma) * 100) / 100,
        saldo_al: s.reference_date || iso(new Date()),
      }).eq("id", c.conto);
      if (error) throw error;
    }
    await db.from("banca_collegamenti").update({ ultimo_sync: new Date().toISOString(), esito: null }).eq("conto", c.conto);
    return { conto: c.conto, nuovi: nuovi.length, saldo };
  } catch (e) {
    const scaduto = e instanceof ErroreBanca && e.scaduto;
    const esito = scaduto ? "scaduto" : String((e as Error).message || e).slice(0, 300);
    await db.from("banca_collegamenti").update({ ultimo_sync: new Date().toISOString(), esito }).eq("conto", c.conto);
    return { conto: c.conto, errore: scaduto ? "Il consenso della banca è scaduto: ricollega il conto." : esito };
  }
}

/* ---------- richieste ---------- */
const risposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Rifiuto extends Error {
  constructor(msg: string, public status = 400) {
    super(msg);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const corpo = await req.json().catch(() => ({}));

    if (corpo.azione === "cron") {
      const segreto = Deno.env.get("CRON_SECRET");
      if (!segreto || req.headers.get("x-cron") !== segreto) throw new Rifiuto("Non autorizzato", 401);
      const { data, error } = await db.from("banca_collegamenti").select("conto,sessione,account_uid,scade")
        .gt("scade", new Date().toISOString());
      if (error) throw error;
      const esiti = [];
      for (const c of data) esiti.push(await sincronizza(c, null));
      return risposta({ esiti });
    }

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) throw new Rifiuto("Accesso richiesto", 401);
    const { data: me } = await db.from("membri").select("persona").eq("user_id", user.id).maybeSingle();
    if (!me) throw new Rifiuto("Account non abilitato", 403);
    const puo = (conto: string) => conto === "comune" || conto === me.persona;
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;

    if (corpo.azione === "avvia") {
      await db.from("banca_attese").delete().lt("creato", new Date(Date.now() - GIORNO).toISOString());
      const { data: a, error } = await db.from("banca_attese").insert({ user_id: user.id }).select("state").single();
      if (error) throw error;
      const r = await eb("POST", "/auth", {
        access: { valid_until: new Date(Date.now() + 179 * GIORNO).toISOString() },
        aspsp: BANCA, state: a.state, redirect_url: APP_URL, psu_type: "personal",
      }, ip);
      return risposta({ url: r.url });
    }

    if (corpo.azione === "conferma") {
      const { data: a } = await db.from("banca_attese").select("*").eq("state", corpo.state).eq("user_id", user.id)
        .maybeSingle();
      if (!a || Date.now() - Date.parse(a.creato) > 3600e3) {
        throw new Rifiuto("Questo collegamento è scaduto o è stato avviato da un altro account: ricomincia da «Collega la banca».");
      }
      if (!a.sessione) { // il codice della banca vale una volta sola: se la pagina viene ricaricata si riusa la sessione
        const s = await eb("POST", "/sessions", { code: corpo.code }, ip);
        // deno-lint-ignore no-explicit-any
        const conti = (s.accounts || []).map((x: any) => ({
          uid: x.uid, nome: x.name || "", iban: String(x.account_id?.iban || "").slice(-4),
          suggerito: /,/.test(x.name || "") ? "comune" : me.persona,
        }));
        const { error } = await db.from("banca_attese").update({ sessione: s.session_id, conti, scade: s.access?.valid_until })
          .eq("state", a.state);
        if (error) throw error;
        Object.assign(a, { sessione: s.session_id, conti, scade: s.access?.valid_until });
      }
      return risposta({ conti: a.conti, scade: a.scade });
    }

    if (corpo.azione === "abbina") {
      const { data: a } = await db.from("banca_attese").select("*").eq("state", corpo.state).eq("user_id", user.id)
        .maybeSingle();
      if (!a?.sessione) throw new Rifiuto("Collegamento non trovato: ricomincia da «Collega la banca».");
      // deno-lint-ignore no-explicit-any
      const scelte = (corpo.scelte || []).filter((x: any) => x.conto);
      const visti = new Set<string>();
      for (const x of scelte) {
        if (!puo(x.conto)) throw new Rifiuto("Conto non accessibile", 403);
        // deno-lint-ignore no-explicit-any
        if (!a.conti.some((c: any) => c.uid === x.uid)) throw new Rifiuto("Conto della banca sconosciuto");
        if (visti.has(x.conto)) throw new Rifiuto("Due conti della banca sullo stesso conto dell'app");
        visti.add(x.conto);
      }
      const righe = scelte.map((x: { uid: string; conto: string }) => ({
        conto: x.conto, sessione: a.sessione, account_uid: x.uid,
        // deno-lint-ignore no-explicit-any
        iban: a.conti.find((c: any) => c.uid === x.uid).iban, scade: a.scade,
        collegato: new Date().toISOString(), collegato_da: user.id, ultimo_sync: null, esito: null,
      }));
      if (righe.length) {
        const { error } = await db.from("banca_collegamenti").upsert(righe, { onConflict: "conto" });
        if (error) throw error;
      }
      await db.from("banca_attese").delete().eq("state", a.state);
      const esiti = [];
      for (const r of righe) esiti.push(await sincronizza(r, user.id, ip));
      return risposta({ esiti });
    }

    if (corpo.azione === "aggiorna") {
      const { data, error } = await db.from("banca_collegamenti").select("conto,sessione,account_uid,scade");
      if (error) throw error;
      const esiti = [];
      for (const c of data.filter((c) => puo(c.conto) && (!corpo.conto || c.conto === corpo.conto))) {
        esiti.push(await sincronizza(c, user.id, ip));
      }
      return risposta({ esiti });
    }

    if (corpo.azione === "scollega") {
      if (!puo(corpo.conto)) throw new Rifiuto("Conto non accessibile", 403);
      const { data: c } = await db.from("banca_collegamenti").select("sessione").eq("conto", corpo.conto).maybeSingle();
      if (c) {
        await db.from("banca_collegamenti").delete().eq("conto", corpo.conto);
        const { count } = await db.from("banca_collegamenti").select("conto", { count: "exact", head: true })
          .eq("sessione", c.sessione);
        if (!count) await eb("DELETE", `/sessions/${c.sessione}`).catch(() => null); // nessun altro conto la usa: revoca il consenso
      }
      return risposta({ ok: true });
    }

    throw new Rifiuto("Azione sconosciuta");
  } catch (e) {
    const status = e instanceof Rifiuto ? e.status : e instanceof ErroreBanca ? 502 : 500;
    console.error(e);
    return risposta({ errore: (e as Error).message || String(e) }, status);
  }
});
