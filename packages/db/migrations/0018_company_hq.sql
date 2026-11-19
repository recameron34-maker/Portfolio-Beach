-- 0018 Company headquarters, for the co-investment map (decision 0017, docs/03 section 1).
-- The city and country of a portfolio company's head office and its coordinates. All four are
-- null until someone records them: a position whose company has none is listed as having no
-- headquarters recorded and is never placed on the map by a guess (rule 10). The columns follow
-- the table's own policies (every authenticated user reads a company; the deal team, operations
-- and the service write it) and its history trigger.
-- Rollback note: drop the five constraints, then the four columns.

alter table core.portfolio_company
  add column hq_city text,
  add column hq_country char(2),
  add column hq_latitude numeric(8, 5),
  add column hq_longitude numeric(8, 5);

alter table core.portfolio_company
  add constraint portfolio_company_hq_city_filled
    check (hq_city is null or length(btrim(hq_city)) > 0),
  -- ISO 3166-1 alpha-2, in capitals.
  add constraint portfolio_company_hq_country_code
    check (hq_country is null or hq_country ~ '^[A-Z]{2}$'),
  add constraint portfolio_company_hq_latitude_range
    check (hq_latitude is null or hq_latitude between -90 and 90),
  add constraint portfolio_company_hq_longitude_range
    check (hq_longitude is null or hq_longitude between -180 and 180),
  -- Whole or not at all: a city with no coordinates cannot be drawn, coordinates with no city
  -- cannot be named.
  add constraint portfolio_company_hq_whole
    check (num_nonnulls(hq_city, hq_country, hq_latitude, hq_longitude) in (0, 4));

comment on column core.portfolio_company.hq_city is 'Head office city, as the company states it.';
comment on column core.portfolio_company.hq_country is 'Head office country, ISO 3166-1 alpha-2.';
comment on column core.portfolio_company.hq_latitude is 'Head office latitude in degrees, north positive.';
comment on column core.portfolio_company.hq_longitude is 'Head office longitude in degrees, east positive.';
