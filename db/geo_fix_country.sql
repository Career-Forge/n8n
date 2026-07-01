-- geo_fix_country.sql -- country-resolution coverage fix (idempotent).
-- Problem: ~50% of cache rows had country_iso=NULL because cf_resolve_location only
-- split on commas + only knew full country names. Workday strings ("United States-
-- Arizona-Chandler") and 3-letter codes ("IND BNGL FL2-3 TWR 3") never yielded a
-- country, so the location gate fail-opened and US jobs leaked into India queries.
-- Fix: (1) split country candidates on commas/dashes/slashes/pipes AND whitespace;
--      (2) add SAFE ISO-3 alpha codes (3 letters never collide with US state codes);
--      (3) backfill null-country rows with the improved resolver.

-- 1) ISO-3 codes (safe; word-like ones can/are/nor deliberately omitted -- those
--    countries still resolve via full name / existing short form).
INSERT INTO geo_countries (name_norm, iso) VALUES
  ('ind','IN'),('gbr','GB'),('aus','AU'),('deu','DE'),('fra','FR'),('irl','IE'),
  ('nld','NL'),('esp','ES'),('ita','IT'),('pol','PL'),('prt','PT'),('swe','SE'),
  ('che','CH'),('sgp','SG'),('jpn','JP'),('chn','CN'),('bra','BR'),('mex','MX'),
  ('isr','IL'),('nzl','NZ'),('zaf','ZA'),('phl','PH'),('idn','ID'),('vnm','VN'),
  ('arg','AR'),('col','CO'),('chl','CL'),('nga','NG'),('egy','EG'),('tur','TR'),
  ('ukr','UA'),('rou','RO'),('aut','AT'),('bel','BE'),('dnk','DK'),('fin','FI'),
  ('grc','GR'),('cze','CZ'),('hun','HU'),('kor','KR'),('hkg','HK'),('twn','TW'),
  ('mys','MY'),('tha','TH'),('sau','SA'),('ken','KE'),('pak','PK'),('bgd','BD'),
  ('lka','LK')
ON CONFLICT (name_norm) DO NOTHING;

-- 2) Improved resolver. ONLY the country-candidate generation changes (norm.cc +
--    the pri-4 country fallback): segments now come from splitting on [,/|-] AND on
--    whitespace, so both "United States-Arizona-Chandler" and "IND BNGL ..." resolve.
CREATE OR REPLACE FUNCTION cf_resolve_location(q text, country_hint text DEFAULT NULL)
RETURNS TABLE(geonameid bigint, lat double precision, lng double precision,
              country_iso char(2), matched text, population bigint) AS $$
  WITH cseg AS (   -- country candidate segments: delimiter-split UNION whitespace-split
    SELECT unnest(regexp_split_to_array(coalesce(q,''), '[,;/|>:()-]')) AS seg
    UNION ALL
    SELECT unnest(regexp_split_to_array(coalesce(q,''), '\s+')) AS seg
  ),
  norm AS (
    SELECT regexp_replace(unaccent(lower(coalesce(split_part(q, ',', 1), ''))),
                          '[^a-z0-9]+', '', 'g') AS k,
           COALESCE(
             nullif(upper(trim(coalesce(country_hint, ''))), ''),
             (SELECT gc.iso FROM cseg s
              JOIN geo_countries gc ON gc.name_norm = regexp_replace(unaccent(lower(trim(s.seg))), '[^a-z0-9]+', '', 'g')
              LIMIT 1)
           ) AS cc
  ),
  cand AS (
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name AS matched, p.population,
           1 AS pri, 1.0::real AS sim
    FROM geo_places p, norm n
    WHERE p.name_norm = n.k AND n.k <> '' AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name, p.population,
           2 AS pri, 1.0::real AS sim
    FROM geo_aliases a JOIN geo_places p ON p.geonameid = a.geonameid, norm n
    WHERE a.alias_norm = n.k AND n.k <> '' AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name, p.population,
           3 AS pri, similarity(p.name_norm, n.k) AS sim
    FROM geo_places p, norm n
    WHERE n.k <> '' AND p.name_norm % n.k AND similarity(p.name_norm, n.k) >= 0.45
      AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name, p.population,
           3 AS pri, similarity(a.alias_norm, n.k) AS sim
    FROM geo_aliases a JOIN geo_places p ON p.geonameid = a.geonameid, norm n
    WHERE n.k <> '' AND a.alias_norm % n.k AND similarity(a.alias_norm, n.k) >= 0.45
      AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    -- country-name fallback (no city matched): now scans delimiter + whitespace segments
    SELECT NULL::bigint, NULL::double precision, NULL::double precision, gc.iso, gc.name_norm, 0::bigint,
           4 AS pri, 1.0::real AS sim
    FROM cseg s
    JOIN geo_countries gc ON gc.name_norm = regexp_replace(unaccent(lower(trim(s.seg))), '[^a-z0-9]+', '', 'g'), norm n
    WHERE (n.cc IS NULL OR gc.iso = n.cc)
  )
  SELECT geonameid, lat, lng, country_iso, matched, population
  FROM cand
  ORDER BY pri, sim DESC, population DESC
  LIMIT 1
$$ LANGUAGE sql STABLE;

-- 3) Backfill: fill country (and coords if newly found) for rows the old resolver missed.
--    Lateral subquery joined by id (can't reference the UPDATE target inside a SRF in FROM).
UPDATE jobs j
SET country_iso = sub.cc,
    lat         = COALESCE(j.lat, sub.lat),
    lng         = COALESCE(j.lng, sub.lng),
    geonameid   = COALESCE(j.geonameid, sub.gid)
FROM (
  SELECT j2.id, r.country_iso AS cc, r.lat, r.lng, r.geonameid AS gid
  FROM jobs j2
  CROSS JOIN LATERAL cf_resolve_location(j2.location) r
  WHERE j2.country_iso IS NULL AND j2.location IS NOT NULL AND j2.location <> ''
    AND r.country_iso IS NOT NULL
) sub
WHERE sub.id = j.id;
