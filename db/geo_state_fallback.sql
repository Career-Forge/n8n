-- geo_state_fallback.sql -- US state-code resolution (pri 5) + allowed_countries backfill (idempotent).
-- Problem: cf_resolve_location returns NULL for "IN - Work from home" (Indiana), "RI - Work from home"
-- etc. -- bare 2-letter codes are excluded (CA=California/Canada, IN=Indiana/India collisions). Those
-- rows then leak as worldwide-remote into specific-country queries. Also 1,735 active remote rows have
-- allowed_countries=NULL (predate classify_workplace), so the gate can't scope them.
-- Fix: (1c) add a pri-5 fallback mapping a bare US state code segment -> US, BELOW pri1-4 city/country
-- matches (so "Bangalore, IN" still -> India via the pri1 city). (1c) re-run the null-country backfill.
-- (1d) backfill allowed_countries for remote jobs whose location names countries.
-- COLLISION NOTE: bare "IN"/"TN" resolve to US (Indiana/Tennessee), not India/Tamil Nadu. India jobs
-- carry a city or the full name "India"; acceptable for observed traffic. Query country_hint overrides.

-- 1c) resolver with pri-5 US-state fallback (only the pri-5 arm is new vs geo_fix_country.sql).
CREATE OR REPLACE FUNCTION cf_resolve_location(q text, country_hint text DEFAULT NULL)
RETURNS TABLE(geonameid bigint, lat double precision, lng double precision,
              country_iso char(2), matched text, population bigint) AS $$
  WITH cseg AS (
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
    -- pri 4: country-name fallback (no city matched)
    SELECT NULL::bigint, NULL::double precision, NULL::double precision, gc.iso, gc.name_norm, 0::bigint,
           4 AS pri, 1.0::real AS sim
    FROM cseg s
    JOIN geo_countries gc ON gc.name_norm = regexp_replace(unaccent(lower(trim(s.seg))), '[^a-z0-9]+', '', 'g'), norm n
    WHERE (n.cc IS NULL OR gc.iso = n.cc)
    UNION ALL
    -- pri 5 (NEW): bare US state code -> US. Fires only when no country was extracted (n.cc IS NULL)
    -- and a segment is exactly a 2-letter US state code. Below city matches so "Bangalore, IN" -> India.
    SELECT NULL::bigint, NULL::double precision, NULL::double precision, 'US'::char(2), 'us-state'::text, 0::bigint,
           5 AS pri, 1.0::real AS sim
    FROM cseg s, norm n
    WHERE n.cc IS NULL
      AND upper(trim(s.seg)) IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
        'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC',
        'ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC')
  )
  SELECT geonameid, lat, lng, country_iso, matched, population
  FROM cand
  ORDER BY pri, sim DESC, population DESC
  LIMIT 1
$$ LANGUAGE sql STABLE;

-- 1c) backfill country for rows the old resolver missed (Indiana etc. now resolve to US).
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

-- 1d) backfill allowed_countries for remote jobs whose location names countries (mirror geo._countries_in).
UPDATE jobs j
SET allowed_countries = sub.ccs
FROM (
  SELECT j2.id, array_agg(DISTINCT gc.iso) AS ccs
  FROM jobs j2
  CROSS JOIN LATERAL (
    SELECT unnest(regexp_split_to_array(coalesce(j2.location,''), '[,;/|>:()-]')) AS s
    UNION ALL
    SELECT unnest(regexp_split_to_array(coalesce(j2.location,''), '\s+')) AS s
  ) seg
  JOIN geo_countries gc
    ON gc.name_norm = regexp_replace(unaccent(lower(trim(seg.s))), '[^a-z0-9]+', '', 'g')
  WHERE j2.workplace_type = 'remote'
    AND j2.allowed_countries IS NULL
    AND j2.location IS NOT NULL AND j2.location <> ''
  GROUP BY j2.id
) sub
WHERE sub.id = j.id AND cardinality(sub.ccs) > 0;
