WITH q AS (SELECT $1::vector AS qvec, websearch_to_tsquery('english', COALESCE($2,'')) AS qtext),
vec AS (
  SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk
  FROM jobs j
  WHERE j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL
  ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 150),
kw AS (
  SELECT j.id, row_number() OVER (ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC) AS rnk
  FROM jobs j
  WHERE j.status='active' AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q)
  ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 150),
fused AS (
  SELECT COALESCE(v.id,k.id) AS id, COALESCE(1.0/(60+v.rnk),0)+COALESCE(1.0/(60+k.rnk),0) AS score
  FROM vec v FULL OUTER JOIN kw k ON v.id=k.id)
SELECT j.id AS job_id, j.title,
       COALESCE(NULLIF(j.company_name,''), c.name, 'Unknown') AS company,
       j.company_domain, j.location, j.remote, j.apply_url, j.url,
       j.jd_text, j.posted_at, j.status, j.trust, j.skills,
       j.seniority, j.employment_type, j.salary_min, j.salary_max, j.salary_currency,
       ct.tier AS tier,
       (f.score
         * (0.6 + 0.4*(LEAST(COALESCE(j.trust,10),30)/30.0))
         * (0.5 + 0.5*exp(-EXTRACT(EPOCH FROM (now()-COALESCE(j.posted_at, now())))/(14*86400)))
         * (CASE COALESCE(ct.tier,'C')
              WHEN 'S' THEN 1.00 WHEN 'A' THEN 0.85 WHEN 'B' THEN 0.72
              WHEN 'D' THEN 0.25 ELSE 0.62 END)            -- desirability tier multiplier
       ) AS rrf_score
FROM fused f
JOIN jobs j ON j.id=f.id
LEFT JOIN companies c ON c.id=j.company_id
LEFT JOIN company_tiers ct ON ct.name_norm = cf_name_norm(COALESCE(NULLIF(j.company_name,''), c.name))
ORDER BY rrf_score DESC LIMIT 200
