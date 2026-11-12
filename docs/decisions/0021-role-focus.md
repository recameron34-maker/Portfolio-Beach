# 0021: A home page and navigation order for each role

- **Status:** Accepted for the prototype, as a first arrangement for the owner to change
- **Date:** 2026-11-12
- **Deciders:** repo owner (asked for it); built in Claude Code

## Context

The owner asked: "Make the tool more focused for each functional area, so the role specific functions are more clear on the home page and the order of the tabs are more focused per role".

Until now every role saw the same thing: one home page (pooled figures, attention, capital activity, charts, data health, a generic list of links) and one navigation in one order, eleven areas and seven data links. An operations person and an investor relations person started from the same list and had to know which parts were theirs.

## Options considered

1. **A separate app or a separate set of pages for each role.** The clearest for each role, and seven of everything to keep in step. A person who holds two roles would have two homes.
2. **Hide what a role does not use.** A short navigation, but a role that may read an area would have no way to reach it, and what is hidden would have to track the API's permissions exactly, which belong to the API.
3. **Order, name and describe, and hide nothing (chosen).** Each role gets its own areas first, under its own name, and a home page that leads with its work. Everything else stays where a person can find it, after the role's own areas.

## Decision

- **One configuration file, `config/role_focus.json`** (rule 9), holds for each sign-in role: the name of its area, one sentence on what the role does here, the areas it works in (in order), the order of the tabs inside an area where that differs, the sections of the home page it uses (in order), and its work list (a link and one line for each place it works).
- **The main navigation** shows three groups: the role's own (Home, then its areas, under the role's name), "More" (every other area, in the usual order) and "Data" (the data links that are not in the role's own group). No link is left out for any role.
- **Tabs inside an area** follow the role's order where the file gives one; the tab an area opens on stays first. Where a role's work is on another page of an area, the area's link goes there for that role (the auditor's Admin link opens the audit trail).
- **The home page** leads with "Your work": the sentence and the work list. Under it come the sections that role uses, in its order. A role is not shown a section it has no use for (investor relations has no capital activity card).
- **It orders and describes; it never grants or hides access.** What a person may open or change stays with the API and row-level security. The descriptions were written from the transition tables (`packages/workflows`) and the role lists of the contract, so a line never names an action the role cannot take. A test checks that every path in the file exists, that every role is covered, and that nothing is dropped from the navigation.
- **A user with several roles** gets the focus of the first one they hold in the file's `precedence` list.

## Consequences

- A person sees their own work first and the same tool underneath: nothing moved to a different address, and every bookmark still works.
- The arrangement is a first draft made without the firm's people in the room. Each line is the owner's to change in the file, without code.
- The work list has links and no counts yet ("3 valuations wait for you"). That needs one count per list from the API and is the next step.
- The tour recording on the site shows the earlier home page until it is recorded again.
