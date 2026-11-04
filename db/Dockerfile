# Local/CI Postgres 16 with pgTAP, so tests exercise the real RLS policies.
# (The stock image has no pgTAP; the RLS negative tests in S1 depend on it.)
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgtap \
 && rm -rf /var/lib/apt/lists/*
