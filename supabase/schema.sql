-- Squizzotti's Banking: schema del database Supabase.
-- Da incollare una volta in Supabase → SQL Editor → New query → Run (si può rieseguire senza danni).
-- Usa lo stesso progetto e gli stessi utenti di Squizzotti's Diet (tabella "membri").
-- Non contiene dati personali: i movimenti arrivano dalla banca (supabase/functions/banca); i primi sono stati importati da XLS.

-- ---------- Chi usa l'app (già presente se c'è Squizzotti's Diet) ----------
create table if not exists public.membri (
  user_id uuid primary key references auth.users on delete cascade,
  persona text not null check (persona in ('matteo', 'anna'))
);
alter table public.membri enable row level security;
drop policy if exists "membri: vedo me stesso" on public.membri;
create policy "membri: vedo me stesso" on public.membri
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------- Conti ----------
-- matteo e anna: personali, li vede solo il titolare. comune: lo vedono entrambi.
create table if not exists public.conti (
  id text primary key check (id in ('matteo', 'anna', 'comune')),
  nome text not null,
  titolare text check (titolare in ('matteo', 'anna'))
);
insert into public.conti (id, nome, titolare) values
  ('matteo', 'Matteo', 'matteo'),
  ('anna', 'Anna', 'anna'),
  ('comune', 'Squizzotti', null)
on conflict (id) do nothing;

-- La regola di accesso di tutta l'app: il conto è il mio oppure è quello comune.
create or replace function public.puo_vedere_conto(p_conto text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.membri m
    where m.user_id = (select auth.uid()) and (p_conto = 'comune' or p_conto = m.persona)
  );
$$;
revoke execute on function public.puo_vedere_conto(text) from public, anon;
grant execute on function public.puo_vedere_conto(text) to authenticated;

alter table public.conti enable row level security;
drop policy if exists "conti: i miei" on public.conti;
create policy "conti: i miei" on public.conti
  for select to authenticated using ((select public.puo_vedere_conto(id)));

-- Saldo del conto = saldo_base + somma dei movimenti della banca importati.
-- saldo_base serve quando l'XLS non parte dall'apertura del conto: l'app lo calcola dal saldo letto in home banking.
alter table public.conti add column if not exists saldo_base numeric(12, 2) not null default 0;
drop policy if exists "conti: allineo il saldo" on public.conti;
create policy "conti: allineo il saldo" on public.conti
  for update to authenticated using ((select public.puo_vedere_conto(id))) with check ((select public.puo_vedere_conto(id)));
revoke update on public.conti from authenticated;
grant update (saldo_base) on public.conti to authenticated; -- dall'app si può cambiare solo questo campo

-- ---------- Categorie (personalizzabili, una lista per conto) ----------
-- tipo: normale = entrate/uscite; trasferimento = giroconti tra conti propri (esclusi dai totali);
--       investimento = soldi investiti (contano per gli obiettivi di investimento, non come spese).
create table if not exists public.categorie (
  conto text not null references public.conti on delete cascade,
  id text not null,
  nome text not null,
  tipo text not null default 'normale' check (tipo in ('normale', 'trasferimento', 'investimento')),
  verso text not null default 'uscita' check (verso in ('uscita', 'entrata')),
  ordine int not null default 0,
  padre text, -- id della categoria principale, per le sottocategorie (es. benzina → auto)
  primary key (conto, id)
);
alter table public.categorie add column if not exists padre text;

-- ---------- Regole che imparano ----------
-- "se la descrizione contiene <testo> allora categoria <categoria>". Nascono quando correggi una categoria.
create table if not exists public.regole (
  id bigint generated always as identity primary key,
  conto text not null references public.conti on delete cascade,
  testo text not null,
  categoria text not null,
  creato timestamptz not null default now(),
  creato_da uuid default auth.uid(),
  unique (conto, testo)
);

-- ---------- Importazioni (un aggiornamento dalla banca con movimenti nuovi, o un vecchio XLS, = una riga) ----------
create table if not exists public.importazioni (
  id bigint generated always as identity primary key,
  conto text not null references public.conti on delete cascade,
  nome_file text,
  dal date,
  al date,
  righe_file int not null default 0,
  righe_importate int not null default 0,
  righe_duplicate int not null default 0,
  caricato timestamptz not null default now(),
  caricato_da uuid default auth.uid()
);

-- ---------- Movimenti ----------
-- causale CONTANTI = entrata/uscita in contanti scritta a mano nell'app (chiave unica, mai uguale a quella di un XLS).
-- causale RETTIFICA = correzione scritta a mano (es. polizza pagata dal vecchio conto): conta nei totali, non nella scheda Altro.
-- chiave = data contabile | causale | importo | descrizione: serve al controllo dei duplicati.
-- Non è unica di proposito: due pagamenti identici nello stesso giorno sono entrambi veri.
-- categoria = solo la scelta fatta a mano su quel movimento (null = decide la regola).
create table if not exists public.movimenti (
  id bigint generated always as identity primary key,
  conto text not null references public.conti on delete cascade,
  data date not null,
  valuta date,
  importo numeric(12, 2) not null,
  causale text,
  descrizione text not null,
  chiave text not null,
  categoria text,
  nota text,
  importazione bigint references public.importazioni on delete cascade,
  creato timestamptz not null default now()
);
create index if not exists movimenti_conto_data on public.movimenti (conto, data);
create index if not exists movimenti_conto_chiave on public.movimenti (conto, chiave);
create index if not exists movimenti_importazione on public.movimenti (importazione);

-- ---------- Obiettivi (risparmio e investimento) ----------
-- modo mensile: "almeno <importo> al mese"; modo totale: "<importo> in tutto, dal ... al ...".
create table if not exists public.obiettivi (
  id bigint generated always as identity primary key,
  conto text not null references public.conti on delete cascade,
  tipo text not null check (tipo in ('risparmio', 'investimento')),
  nome text not null,
  importo numeric(12, 2) not null check (importo > 0),
  modo text not null default 'mensile' check (modo in ('mensile', 'totale')),
  dal date not null default date_trunc('month', now())::date,
  al date,
  creato timestamptz not null default now()
);

-- ---------- Accesso: stessa regola su tutte le tabelle ----------
do $$
declare t text;
begin
  foreach t in array array['categorie', 'regole', 'importazioni', 'movimenti', 'obiettivi'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: conti visibili" on public.%I', t, t);
    execute format('create policy "%s: conti visibili" on public.%I for all to authenticated '
                   'using ((select public.puo_vedere_conto(conto))) with check ((select public.puo_vedere_conto(conto)))', t, t);
  end loop;
end $$;

-- ---------- Importazione di un XLS in un colpo solo (prima versione, non più usata dall'app) ----------
-- Riceve solo le righe confermate nell'anteprima (i duplicati scartati non arrivano qui).
-- O entra tutto o niente: un errore a metà non lascia importazioni zoppe.
create or replace function public.importa_movimenti(
  p_conto text, p_nome_file text, p_righe_file int, p_righe_duplicate int, p_movimenti jsonb
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare imp bigint;
begin
  if not public.puo_vedere_conto(p_conto) then raise exception 'Conto non accessibile'; end if;
  insert into public.importazioni (conto, nome_file, dal, al, righe_file, righe_importate, righe_duplicate)
  select p_conto, p_nome_file, min((m->>'data')::date), max((m->>'data')::date),
         p_righe_file, count(*), p_righe_duplicate
  from jsonb_array_elements(p_movimenti) m
  returning id into imp;
  insert into public.movimenti (conto, data, valuta, importo, causale, descrizione, chiave, importazione)
  select p_conto, (m->>'data')::date, (m->>'valuta')::date, (m->>'importo')::numeric,
         m->>'causale', m->>'descrizione', m->>'chiave', imp
  from jsonb_array_elements(p_movimenti) m;
  return imp;
end $$;
revoke execute on function public.importa_movimenti(text, text, int, int, jsonb) from public, anon;
grant execute on function public.importa_movimenti(text, text, int, int, jsonb) to authenticated;

-- Aggiornamenti in tempo reale (se uno dei due importa, l'altro vede subito il conto comune aggiornato).
do $$
declare t text;
begin
  foreach t in array array['categorie', 'regole', 'importazioni', 'movimenti', 'obiettivi'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- Collegamento con la banca (Enable Banking, sola lettura) ----------
-- Le scrive solo la funzione supabase/functions/banca (chiave di servizio). Dall'app si leggono e basta.
-- saldo_al = giorno del saldo comunicato dalla banca; la funzione aggiorna anche saldo_base di conseguenza.
alter table public.conti add column if not exists saldo_al date;

-- Consensi in corso: tra il clic su «Collega la banca» e la scelta dei conti. Nessuna policy: solo la funzione.
create table if not exists public.banca_attese (
  state uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  sessione text,
  conti jsonb,
  scade timestamptz,
  creato timestamptz not null default now()
);
alter table public.banca_attese enable row level security;
revoke all on public.banca_attese from anon, authenticated;

-- Un conto dell'app = un conto della banca. sessione e account_uid restano invisibili all'app.
create table if not exists public.banca_collegamenti (
  conto text primary key references public.conti on delete cascade,
  sessione text not null,
  account_uid text not null,
  iban text, -- solo le ultime 4 cifre
  scade timestamptz not null,
  collegato timestamptz not null default now(),
  collegato_da uuid references auth.users on delete set null,
  ultimo_sync timestamptz,
  esito text -- null = tutto bene; "scaduto" = consenso da rinnovare; altrimenti l'errore
);
alter table public.banca_collegamenti enable row level security;
drop policy if exists "banca_collegamenti: conti visibili" on public.banca_collegamenti;
create policy "banca_collegamenti: conti visibili" on public.banca_collegamenti
  for select to authenticated using ((select public.puo_vedere_conto(conto)));
revoke all on public.banca_collegamenti from anon, authenticated;
grant select (conto, iban, scade, collegato, ultimo_sync, esito) on public.banca_collegamenti to authenticated;

-- ---------- Carta prepagata (NEXI) ----------
-- Un conto dell'app può avere due collegamenti: fonte "conto" (Banca Valsabbina) e fonte "carta" (NEXI).
-- I movimenti della carta hanno causale CARTA; carta_saldo / carta_saldo_al = saldo della prepagata letto da NEXI.
alter table public.banca_attese add column if not exists banca text not null default 'valsabbina';
alter table public.banca_collegamenti add column if not exists fonte text not null default 'conto';
alter table public.banca_collegamenti drop constraint if exists banca_collegamenti_fonte_check;
alter table public.banca_collegamenti add constraint banca_collegamenti_fonte_check check (fonte in ('conto', 'carta'));
alter table public.banca_collegamenti drop constraint if exists banca_collegamenti_pkey;
alter table public.banca_collegamenti add primary key (conto, fonte);
grant select (fonte) on public.banca_collegamenti to authenticated;
alter table public.conti add column if not exists carta_saldo numeric(12, 2);
alter table public.conti add column if not exists carta_saldo_al date;
