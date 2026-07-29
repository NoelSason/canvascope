-- Remove the Canvascope Pro subscription backend (reverts 20260712005329_extension_pro).
--
-- Subscription tiers were explored for v11 and cut before launch: Canvascope
-- ships with every feature free, so there is no entitlement to store and no
-- usage to meter. The AI proxies no longer read either table, the Stripe edge
-- functions (stripe-webhook, create-checkout-session, create-portal-session,
-- get-entitlements) are deleted, and nothing else in the database references
-- these objects.

drop function if exists public.increment_ai_usage(uuid, date, text);

drop table if exists public.ai_usage_daily;
drop table if exists public.extension_subscriptions;
