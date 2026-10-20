# Squizzotti's Banking

Web app installabile (PWA) per tenere traccia dei conti correnti di Matteo e Anna (Banca Valsabbina): conto personale di Matteo, conto personale di Anna e conto in comune "Squizzotti", ognuno con la sua dashboard.

- **Frontend**: file statici pubblicati con GitHub Pages.
- **Dati**: Supabase, stesso progetto e stessi utenti di Squizzotti's Diet. Ognuno vede **solo il proprio conto e quello comune**: la regola è nel database (Row Level Security), non solo nell'interfaccia.
- **Banca**: i movimenti arrivano direttamente da Banca Valsabbina tramite Enable Banking (PSD2, sola lettura). La funzione Supabase `supabase/functions/banca` custodisce la chiave privata (secret `EB_APP_ID`, `EB_PRIVATE_KEY`), gestisce il consenso e scarica i movimenti nuovi; `pg_cron` la chiama due volte al giorno (`supabase/cron-banca.sql`, secret `CRON_SECRET`).

Questo repository è pubblico: **non contiene dati personali né chiavi segrete**. Estratti conto (`*.xls`, `*.xlsx`, `*.csv`, `*.pdf`) e chiavi (`*.pem`) sono esclusi da `.gitignore`.

## Struttura

| File | Cosa fa |
|---|---|
| `index.html` | Pagina, schermata di accesso |
| `app.js` | Interfaccia: conti, panoramica, movimenti, categorie, obiettivi, collegamento con la banca |
| `js/logica.js` | Chiave anti-duplicati, esercente, categorie predefinite, classificazione (usabile anche da Node) |
| `app.css` | Stile (brand Allos) |
| `fonts/` | Akira Expanded Super Bold, licenza web di Allos |
| `config.js` | URL e chiave publishable di Supabase |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installazione sul telefono e uso offline |
| `supabase/schema.sql` | Tabelle e regole di accesso |
| `supabase/functions/banca/` | Collegamento con la banca: consenso, scelta dei conti, aggiornamento, saldo |
| `supabase/cron-banca.sql` | Aggiornamento automatico (modello: il segreto non sta nel repository) |

## Dati di Banca Valsabbina

Ogni movimento ha `remittance_information`: una delle righe è `Causale Movimento: XX` (il codice causale della banca), le altre unite da spazi formano la descrizione, identica a quella degli estratti conto XLS usati nella prima versione. Il saldo arriva dalla banca: la funzione imposta `conti.saldo_base` = saldo − somma dei movimenti bancari salvati e `conti.saldo_al`.

## Duplicati

Un movimento è un duplicato se **data contabile, causale, importo e descrizione** coincidono con un movimento già salvato (`chiave`). Il confronto tiene conto di quante volte compare una chiave: due pagamenti identici nello stesso giorno sono entrambi veri. Al primo collegamento di un conto si scarica tutto lo storico concesso dalla banca (disponibile solo nella prima ora dal consenso); poi si riparte da 10 giorni prima dell'ultimo movimento salvato.

## Categorie

Ordine di decisione: scelta a mano sul movimento → regole imparate (vince la più lunga) → codice causale della banca → elenco di esercenti italiani → "Da classificare" / "Altre entrate". Quando si corregge una categoria si può creare una regola ("se la descrizione contiene X"), che vale per i movimenti presenti e futuri. La categoria calcolata non si salva: si salva solo la scelta a mano, così una regola nuova si applica subito anche al passato.

Tipi di categoria: **normale** (entrate/uscite), **trasferimento** (giroconti tra conti propri, esclusi dai totali), **investimento** (non sono spese; contano per gli obiettivi di investimento).

## Obiettivi (conti personali)

- **Risparmio**: entrate meno uscite (giroconti e investimenti esclusi).
- **Investimento**: movimenti nelle categorie di tipo investimento.
- Modo **mensile** ("almeno X al mese") o **totale** ("X in tutto, dal mese A al mese B", con il confronto con la tabella di marcia).

## Database

`supabase/schema.sql` va eseguito una volta nel SQL Editor di Supabase (si può rieseguire). Richiede la tabella `membri` già usata da Squizzotti's Diet (la crea se manca).

## Rilasciare una nuova versione

Dopo aver cambiato i file, aumentare `VERSION` in `sw.js`, poi commit e push su `main`.
