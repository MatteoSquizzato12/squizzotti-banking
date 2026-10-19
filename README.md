# Squizzotti's Banking

Web app installabile (PWA) per tenere traccia dei conti correnti di Matteo e Anna (Banca Valsabbina): conto personale di Matteo, conto personale di Anna e conto in comune "Squizzotti", ognuno con la sua dashboard.

- **Frontend**: file statici pubblicati con GitHub Pages.
- **Dati**: Supabase, stesso progetto e stessi utenti di Squizzotti's Diet. Ognuno vede **solo il proprio conto e quello comune**: la regola è nel database (Row Level Security), non solo nell'interfaccia.
- **Import**: gli XLS esportati dall'home banking si leggono nel browser con SheetJS (`vendor/xlsx.core.min.js`, caricato solo nella sezione Importa). Il file non viene caricato da nessuna parte: arrivano a Supabase solo i movimenti confermati.

Questo repository è pubblico: **non contiene dati personali né chiavi segrete**. Gli estratti conto (`*.xls`, `*.xlsx`, `*.csv`, `*.pdf`) sono esclusi da `.gitignore`.

## Struttura

| File | Cosa fa |
|---|---|
| `index.html` | Pagina, schermata di accesso |
| `app.js` | Interfaccia: conti, panoramica, movimenti, categorie, obiettivi, importazione |
| `js/logica.js` | Lettura XLS, chiave anti-duplicati, esercente, categorie predefinite, classificazione (usabile anche da Node) |
| `app.css` | Stile (brand Allos) |
| `vendor/` | SheetJS Community Edition 0.20.3 (licenza Apache 2.0) |
| `fonts/` | Akira Expanded Super Bold, licenza web di Allos |
| `config.js` | URL e chiave publishable di Supabase |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installazione sul telefono e uso offline |
| `supabase/schema.sql` | Tabelle, regole di accesso e funzione di importazione |

## Formato XLS di Banca Valsabbina

Un foglio, intestazione `Data contabile | Valuta | Dare | Avere | Divisa | Causale | Descrizione`. Date come numeri di serie Excel, Dare negativo e Avere positivo. Nel file non c'è l'IBAN: il conto si sceglie nell'app, che avvisa se le carte nel file appartengono a un altro conto.

## Duplicati

Un movimento è un duplicato se **data contabile, causale, importo e descrizione** coincidono con un movimento già salvato (`chiave`). L'anteprima esclude in automatico i duplicati e li mostra a parte; le righe identiche dentro lo stesso file vengono importate tutte (sono pagamenti veri ripetuti). Prima di salvare l'app ricontrolla il database, nel caso l'altro abbia importato lo stesso periodo nel frattempo. Ogni importazione si può annullare.

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
