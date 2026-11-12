-- 0017 Review finding D1-06 and the owner's decisions of 2026-11-11: the investment team reads
-- every client, and a client-level allocation line of a deal is read by whoever reads its client
-- (docs/03 sections 1 and 3, docs/05 SEC-5.2 and SEC-5.4, decision 0013).
-- Rollback note: recreate pb.sees_all_clients() as migration 0001 defines it (operations, approver,
-- auditor); recreate read_visible on deal.allocation as migration 0013 defines it (the two anchor
-- clauses without the client clause).

----------------------------------------------------------------------------------------------
-- pb.sees_all_clients: the roles that read every client's Restricted data without an entitlement.
-- Migration 0001 named operations, approvers and auditors. The owner decided on 2026-11-11 that the
-- investment team works on client matters throughout, so the deal team joins them: operations, the
-- deal team and approvers (the investment team) and the auditor read every client. Investor
-- relations keeps its per-client entitlement (pb.entitled_client), a viewer reads no client data,
-- and platform admins are still deliberately absent (SEC-5.4). The three client policies of
-- migration 0006 (core.client, core.lp_commitment and the client-level rows of core.commitment)
-- call this function, so they follow the new definition with no change of their own.
----------------------------------------------------------------------------------------------
create or replace function pb.sees_all_clients() returns boolean
language sql stable as $$
  select pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor'])
$$;

----------------------------------------------------------------------------------------------
-- deal.allocation, read_visible: migration 0013 let anyone who can see a deal read every allocation
-- line of it, client lines included, so a client's amount on a deal was readable without any
-- entitlement to that client (D1-06). A line still follows its opportunity when it has one,
-- otherwise its investment; a client line (client_id set) is now also under the client rule that
-- already governs client data: a role that reads every client, or an entitlement to that client. A
-- vehicle-level line (client_id null) reads as before. The system actor keeps reading every line:
-- the API reads the totals of a deal (the number of lines, how many have no received amount, the
-- sums) as the system actor and returns nothing but those figures, so the tie-out against the
-- commitment reads the same for every reader and a reader shown fewer lines is told how many are
-- not shown. The write policies of migration 0013 are unchanged: the deal team, operations and the
-- system actor write, and all three read every line, so a replace of the list leaves no line its
-- writer cannot read (the access matrix proves it).
----------------------------------------------------------------------------------------------
drop policy read_visible on deal.allocation;
create policy read_visible on deal.allocation for select to pb_app
  using (((opportunity_id is not null and pb.opportunity_visible(opportunity_id))
      or (opportunity_id is null and pb.investment_visible(investment_id)))
    and (client_id is null or pb.has_role('service') or pb.sees_all_clients() or pb.entitled_client(client_id)));
