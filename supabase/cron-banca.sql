-- Aggiornamento automatico dei conti collegati alla banca, due volte al giorno (7:15 e 17:15 ora italiana d'inverno).
-- Da eseguire una volta nel SQL Editor di Supabase DOPO aver pubblicato la funzione "banca".
-- <SEGRETO> = lo stesso valore del secret CRON_SECRET della funzione (non va scritto in questo file del repository).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret('<SEGRETO>', 'banca_cron', 'Chiave per l''aggiornamento automatico dalla banca');
select cron.unschedule('banca-aggiorna') where exists (select 1 from cron.job where jobname = 'banca-aggiorna');
select cron.schedule('banca-aggiorna', '15 6,16 * * *', $$
  select net.http_post(
    url := 'https://ckcbfxjsljiddplzqjpz.supabase.co/functions/v1/banca',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'banca_cron')),
    body := '{"azione":"cron"}'::jsonb,
    timeout_milliseconds := 60000);
$$);
