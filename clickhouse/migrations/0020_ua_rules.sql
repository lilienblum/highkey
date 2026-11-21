-- Browser/OS refinements from ua-parser/uap-core 73e7340c (Apache-2.0, see
-- docs/licenses/uap-core.txt). Only bounded versions and fixed family names are attributes;
-- never extract the device model, the remaining UA string, or arbitrary family text.
CREATE TABLE IF NOT EXISTS highkey.ua_rules
(id UInt64,parent_id UInt64,regexp String,keys Array(String),values Array(String))
ENGINE=ReplacingMergeTree ORDER BY id;

INSERT INTO highkey.ua_rules SELECT * FROM VALUES(
 'id UInt64,parent_id UInt64,regexp String,keys Array(String),values Array(String)',
 (1,0,'SamsungBrowser/([0-9]{1,4}\\.[0-9]{1,4})',['browser','bv'],['Samsung Internet','$1']),
 (2,0,'Vivaldi/([0-9.]{1,24})',['browser','bv'],['Vivaldi','$1']),
 (3,0,'PaleMoon/([0-9.]{1,24})',['browser','bv'],['Pale Moon','$1']),
 (4,0,'Waterfox/([0-9.]{1,24})',['browser','bv'],['Waterfox','$1']),
 (5,0,'SeaMonkey/([0-9.]{1,24})',['browser','bv'],['SeaMonkey','$1']),
 (6,0,'DuckDuckGo/([0-9.]{1,24})',['browser','bv'],['DuckDuckGo','$1']),
 (7,0,'Chromium/([0-9.]{1,24})',['browser','bv'],['Chromium','$1']),
 (8,0,'HarmonyOS[ ;]+([0-9.]{1,24})',['os','ov'],['HarmonyOS','$1']),
 (9,0,'Tizen[/ ]([0-9.]{1,24})',['os','ov'],['Tizen','$1']),
 (10,0,'Ubuntu(?:[/ ]([0-9.]{1,24}))?',['os','ov'],['Ubuntu','$1']),
 (11,0,'FreeBSD(?:[/ ]([0-9.]{1,24}))?',['os','ov'],['FreeBSD','$1'])
) WHERE id NOT IN (SELECT id FROM highkey.ua_rules);

GRANT SELECT ON highkey.ua_rules TO highkey_geo_reader;
CREATE OR REPLACE DICTIONARY highkey.ua_lookup
(regexp String,browser String,bv String,os String,ov String)
PRIMARY KEY regexp SOURCE(CLICKHOUSE(USER 'highkey_geo_reader' DB 'highkey' TABLE 'ua_rules'))
LAYOUT(REGEXP_TREE()) LIFETIME(0);

GRANT dictGet ON highkey.ua_lookup TO highkey_definer;
CREATE OR REPLACE FUNCTION highkey_browser AS ua -> if(ua='','',coalesce(nullIf(dictGet('highkey.ua_lookup','browser',ua),''),
 multiIf(match(ua,'Edg(?:e|A|iOS)?/'),'Edge',match(ua,'OPR/'),'Opera',match(ua,'(?:Firefox|FxiOS)/'),'Firefox',
 match(ua,'(?:Chrome|CriOS)/'),'Chrome',match(ua,'Version/[^ ]+.*Safari/'),'Safari','')));
CREATE OR REPLACE FUNCTION highkey_browser_version AS (ua,b) -> multiIf(
 b='Edge',extract(ua,'Edg(?:e|A|iOS)?/([0-9.]+)'),b='Opera',extract(ua,'OPR/([0-9.]+)'),
 b='Firefox',extract(ua,'(?:Firefox|FxiOS)/([0-9.]+)'),b='Chrome',extract(ua,'(?:Chrome|CriOS)/([0-9.]+)'),
 b='Safari',extract(ua,'Version/([0-9.]+)'),b='','',dictGet('highkey.ua_lookup','bv',ua));
CREATE OR REPLACE FUNCTION highkey_os AS ua -> if(ua='','',coalesce(nullIf(dictGet('highkey.ua_lookup','os',ua),''),
 multiIf(match(ua,'(?:iPhone|iPad|iPod)'),'iOS',match(ua,'Android'),'Android',match(ua,'CrOS'),'Chrome OS',
 match(ua,'Windows NT'),'Windows',match(ua,'Mac OS X'),'macOS',match(ua,'Linux'),'Linux','')));
CREATE OR REPLACE FUNCTION highkey_os_version AS (ua,os) -> multiIf(
 os='iOS',replaceAll(extract(ua,'OS ([0-9_]+)'),'_','.'),
 os='macOS',replaceAll(extract(ua,'Mac OS X ([0-9_.]+)'),'_','.'),
 os='Android',extract(ua,'Android ([0-9.]+)'),os='Chrome OS',extract(ua,'CrOS [^ ]+ ([0-9.]+)'),
 os='Windows',extract(ua,'Windows NT ([0-9.]+)'),os IN ('Ubuntu','FreeBSD','Tizen','HarmonyOS'),dictGet('highkey.ua_lookup','ov',ua),'');
