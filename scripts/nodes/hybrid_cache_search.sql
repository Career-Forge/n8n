WITH q AS (SELECT $1::vector AS qvec, websearch_to_tsquery('english', COALESCE($2,'')) AS qtext),
-- L2: resolve the query's free-text location once via the gazetteer (0 or 1 row).
-- $3 = location_canonical, $4 = country hint, $5 = remote_preference, $6 = company_rx.
loc AS (SELECT * FROM cf_resolve_location($3, $4) LIMIT 1),
-- The country gate engages on a bare country too ("Netherlands" -> $4='NL", $3=null).
gc AS (SELECT COALESCE((SELECT country_iso FROM loc), NULLIF(upper($4), '')) AS ci),
vec AS (
  SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk
  FROM jobs j
  WHERE j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL
    AND (
      (SELECT ci FROM gc) IS NULL                              -- no country queried -> no gate
      OR (j.workplace_type = 'remote' AND (                    -- remote: worldwide OR explicitly allows the country
            ((j.allowed_countries IS NULL OR cardinality(j.allowed_countries) = 0)  -- no scope declared = worldwide...
               AND (j.country_iso IS NULL OR j.country_iso = (SELECT ci FROM gc)))  --   ...and location-agnostic or in-country
            OR (SELECT ci FROM gc) = ANY(j.allowed_countries)))                     -- scoped remote: queried country must be allowed
      OR (j.workplace_type IS DISTINCT FROM 'remote'           -- onsite/hybrid: MUST be in the queried country
            AND j.country_iso = (SELECT ci FROM gc))           --   (no null fail-open -> unknown-country jobs drop)
    )
    AND ($5 IS DISTINCT FROM 'remote_only' OR j.workplace_type='remote')
    AND (NULLIF($6,'') IS NULL OR j.company_name ~* ('\y(' || $6 || ')\y'))  -- company gate (when an employer is named)
  ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 150),
kw AS (
  SELECT j.id, row_number() OVER (ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC) AS rnk
  FROM jobs j
  WHERE j.status='active' AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q)
    AND (
      (SELECT ci FROM gc) IS NULL
      OR (j.workplace_type = 'remote' AND (
            ((j.allowed_countries IS NULL OR cardinality(j.allowed_countries) = 0)
               AND (j.country_iso IS NULL OR j.country_iso = (SELECT ci FROM gc)))
            OR (SELECT ci FROM gc) = ANY(j.allowed_countries)))
      OR (j.workplace_type IS DISTINCT FROM 'remote'
            AND j.country_iso = (SELECT ci FROM gc))
    )
    AND ($5 IS DISTINCT FROM 'remote_only' OR j.workplace_type='remote')
    AND (NULLIF($6,'') IS NULL OR j.company_name ~* ('\y(' || $6 || ')\y'))
  ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 150),
fused AS (
  SELECT COALESCE(v.id,k.id) AS id, COALESCE(1.0/(60+v.rnk),0)+COALESCE(1.0/(60+k.rnk),0) AS score
  FROM vec v FULL OUTER JOIN kw k ON v.id=k.id)
SELECT j.id AS job_id, j.title,
       COALESCE(NULLIF(j.company_name,''), c.name, 'Unknown') AS company,
       j.company_domain, j.location, j.remote, j.apply_url, j.url,
       j.source, j.board, j.external_id,
       j.jd_text, j.posted_at, j.status, j.trust, j.skills,
       j.seniority, j.employment_type, j.salary_min, j.salary_max, j.salary_currency,
       j.lat, j.lng, j.country_iso, j.workplace_type, j.allowed_countries,
       ct.tier AS tier,
       (f.score
         * (0.6 + 0.4*(LEAST(COALESCE(j.trust,10),30)/30.0))
         * (0.5 + 0.5*exp(-EXTRACT(EPOCH FROM (now()-COALESCE(j.posted_at, now())))/(14*86400)))
         * (CASE COALESCE(ct.tier,'C')
              WHEN 'S' THEN 1.00 WHEN 'A' THEN 0.85 WHEN 'B' THEN 0.72
              WHEN 'D' THEN 0.25 ELSE 0.62 END)            -- desirability tier multiplier
         * (CASE WHEN (SELECT lat FROM loc) IS NULL THEN 1.0               -- no city queried: neutral
                 WHEN j.workplace_type='remote' THEN 0.85                   -- remote: location-independent (flat)
                 WHEN j.lat IS NOT NULL                                     -- onsite/hybrid w/ coords: local BOOST
                   THEN 0.7 + 0.6*exp(-earth_distance(ll_to_earth((SELECT lat FROM loc),(SELECT lng FROM loc)),
                                                      ll_to_earth(j.lat,j.lng))/40000.0)   -- ~1.3 local, ~0.7 far
                 ELSE 0.5 END)                             -- onsite/hybrid but ungeocoded: penalize (ambiguous)
       ) AS rrf_score
FROM fused f
JOIN jobs j ON j.id=f.id
LEFT JOIN companies c ON c.id=j.company_id
LEFT JOIN company_tiers ct ON ct.name_norm = cf_name_norm(COALESCE(NULLIF(j.company_name,''), c.name))
ORDER BY rrf_score DESC LIMIT 200
