-- Operators load only CIDR, ISO country/region and an optional hosting-network flag.
CREATE TABLE IF NOT EXISTS highkey.geo_networks (
  cidr String, country String, region String, hosting UInt8 DEFAULT 0
) ENGINE=MergeTree ORDER BY cidr;

CREATE USER IF NOT EXISTS highkey_geo_reader IDENTIFIED WITH no_password HOST LOCAL;
GRANT SELECT ON highkey.geo_networks TO highkey_geo_reader;

CREATE OR REPLACE DICTIONARY highkey.geo_lookup
(cidr String, country String DEFAULT '', region String DEFAULT '', hosting UInt8 DEFAULT 0)
PRIMARY KEY cidr SOURCE(CLICKHOUSE(USER 'highkey_geo_reader' DB 'highkey' TABLE 'geo_networks'))
LAYOUT(IP_TRIE()) LIFETIME(MIN 300 MAX 600);

CREATE OR REPLACE FUNCTION highkey_browser AS ua -> multiIf(
  match(ua,'Edg(?:e|A|iOS)?/'),'Edge',match(ua,'OPR/'),'Opera',match(ua,'(?:Firefox|FxiOS)/'),'Firefox',
  match(ua,'(?:Chrome|CriOS)/'),'Chrome',match(ua,'Version/[^ ]+.*Safari/'),'Safari','');

CREATE OR REPLACE FUNCTION highkey_browser_version AS (ua,b) -> multiIf(
  b='Edge',extract(ua,'Edg(?:e|A|iOS)?/([0-9.]+)'),b='Opera',extract(ua,'OPR/([0-9.]+)'),
  b='Firefox',extract(ua,'(?:Firefox|FxiOS)/([0-9.]+)'),b='Chrome',extract(ua,'(?:Chrome|CriOS)/([0-9.]+)'),
  b='Safari',extract(ua,'Version/([0-9.]+)'),'');

CREATE OR REPLACE FUNCTION highkey_os AS ua -> multiIf(
  match(ua,'(?:iPhone|iPad|iPod)'),'iOS',match(ua,'Android'),'Android',match(ua,'CrOS'),'Chrome OS',
  match(ua,'Windows NT'),'Windows',match(ua,'Mac OS X'),'macOS',match(ua,'Linux'),'Linux','');

CREATE OR REPLACE FUNCTION highkey_os_version AS (ua,os) -> multiIf(
  os='iOS',replaceAll(extract(ua,'OS ([0-9_]+)'),'_','.'),
  os='macOS',replaceAll(extract(ua,'Mac OS X ([0-9_.]+)'),'_','.'),
  os='Android',extract(ua,'Android ([0-9.]+)'),os='Chrome OS',extract(ua,'CrOS [^ ]+ ([0-9.]+)'),
  os='Windows',extract(ua,'Windows NT ([0-9.]+)'),'');

CREATE OR REPLACE FUNCTION highkey_device AS ua -> multiIf(
  match(ua,'(?i)smart-tv|smarttv|hbbtv'),'TV',match(ua,'iPad|Tablet') OR (match(ua,'Android') AND NOT match(ua,'Mobile')),'Tablet',
  match(ua,'Mobile|iPhone|iPod'),'Mobile',highkey_os(ua)!='','Desktop','');

CREATE OR REPLACE FUNCTION highkey_acquisition_type AS (ref,medium) -> multiIf(
  match(lower(medium),'^(cpc|ppc|paid.*|display|cpm)$'),'paid',match(lower(medium),'^(email|e-mail|newsletter)$'),'email',
  match(lower(ref),'(^|[.])(chatgpt|openai|perplexity|claude|gemini|copilot)([.]|$)'),'ai',
  match(lower(ref),'(^|[.])(google|bing|duckduckgo|yahoo|baidu|yandex|ecosia)([.]|$)'),'search',
  match(lower(ref),'(^|[.])(x|t[.]co|twitter|linkedin|lnkd[.]in|facebook|instagram|reddit|youtube|tiktok|threads|bsky)([.]|$)'),'social',
  ref='' OR lower(ref)='direct','direct','referral');

CREATE OR REPLACE FUNCTION highkey_hosting AS ip -> multiIf(
  isIPv4String(ip),dictGetOrDefault('highkey.geo_lookup','hosting',tuple(IPv4StringToNumOrDefault(ip)),toUInt8(0)),
  isIPv6String(ip),dictGetOrDefault('highkey.geo_lookup','hosting',tuple(IPv6StringToNumOrDefault(ip)),toUInt8(0)),toUInt8(0));

ALTER TABLE highkey.events
  ADD COLUMN IF NOT EXISTS request_ip String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS request_ua String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS request_site String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS request_web UInt8 EPHEMERAL,
  ADD COLUMN IF NOT EXISTS request_fetch UInt8 EPHEMERAL,
  ADD COLUMN IF NOT EXISTS geo Tuple(String,String,UInt8) MATERIALIZED if(
    isIPv4String(request_ip),dictGetOrDefault('highkey.geo_lookup',('country','region','hosting'),tuple(IPv4StringToNumOrDefault(request_ip)),tuple('','',toUInt8(0))),
    if(isIPv6String(request_ip),dictGetOrDefault('highkey.geo_lookup',('country','region','hosting'),tuple(IPv6StringToNumOrDefault(request_ip)),tuple('','',toUInt8(0))),tuple('','',toUInt8(0)))),
  ADD COLUMN IF NOT EXISTS browser LowCardinality(String) MATERIALIZED highkey_browser(request_ua),
  ADD COLUMN IF NOT EXISTS browser_version LowCardinality(String) MATERIALIZED highkey_browser_version(request_ua,highkey_browser(request_ua)),
  ADD COLUMN IF NOT EXISTS os_family LowCardinality(String) MATERIALIZED highkey_os(request_ua),
  ADD COLUMN IF NOT EXISTS os_version LowCardinality(String) MATERIALIZED highkey_os_version(request_ua,highkey_os(request_ua)),
  ADD COLUMN IF NOT EXISTS device LowCardinality(String) MATERIALIZED highkey_device(request_ua),
  ADD COLUMN IF NOT EXISTS bot LowCardinality(String) MATERIALIZED multiIf(
    match(request_ua,'(?i)bot[/ ;)]|crawler|spider|headlesschrome|lighthouse|facebookexternalhit|slurp'),'known',
    request_web=1 AND (highkey_hosting(request_ip)=1 OR (request_fetch=0 AND match(request_ua,'Mozilla/'))),'suspected',''),
  ADD COLUMN IF NOT EXISTS referrer_name LowCardinality(String) MATERIALIZED coalesce(
    nullIf(properties.utm_source.:String,''),nullIf(properties.ref.:String,''),
    nullIf(if(lower(ifNull(properties.referrer.:String,''))=lower(request_site),'',ifNull(properties.referrer.:String,'')),''),''),
  ADD COLUMN IF NOT EXISTS referrer_type LowCardinality(String) MATERIALIZED highkey_acquisition_type(referrer_name,ifNull(properties.utm_medium.:String,''));

GRANT dictGet ON highkey.geo_lookup TO highkey_definer;

ALTER SETTINGS PROFILE highkey_reader ADD SETTINGS SQL_highkey_include_bots = '0' CHANGEABLE_IN_READONLY;

-- Ingest errors can quote the rejected input. Keep query logging for report readers only.
ALTER SETTINGS PROFILE highkey_ingest ADD SETTINGS log_queries = 0 CONST;
