# Setup checklist

The collapsed setup for the lead developer ("Setup for the lead developer" in [page-template.md](page-template.md)) is built from this list. Each item is verified before the session, not on the day. The page states the result of each check as an expected value, never as a step the lead developer has to work out.

## Environment

- The deployed build is the intended commit. Record the commit in `sources.md` and print it on the page next to the URL. Check it in the app or in the deploy log, whichever the team trusts. A pushed head is not a deployed one: confirm the deploy finished on that commit before seeding, or the seed of the previous build runs.
- When probing the environment from a script, send the headers a browser sends (for example `Accept: text/html`). An app can answer a bare request with an error page while serving browsers normally.
- The feature switch is on for the test scope and the page names its exact UI label and where to see it. Write down how to turn it off, for the scenario that needs it.
- Every URL on the page is a real, working link to the test environment. No "[id]" in a link.
- Every on-screen word in the setup is the exact label the UI shows, as in the scenarios ([page-template.md](page-template.md) "Labels").

## Seed

- The seed is one command, safe to run twice, and prints one labeled line per check the page relies on. Each line is copied into the setup's Data item with its exact value.
- The seed makes every scenario possible. Build the list from the scenarios: for each one, the record it needs (a user with a role, a record in the state that shows an empty-state button, a client with no data). A missing record means the seed changes, with a test for the change. Console patching is not a fix for a seed gap.
- Counts never rely on data copied into the test environment from elsewhere. Either filter the check to seeded records, or write the count as "any number" and say why in the scenario's Context line.
- Every user named on the page exists after the seed, with the role the scenario needs. The seed output prints "found N of N".
- Any data write is on the test environment only. Read-only queries come first when checking a value on a shared store.

## Sign-in

- Each user signs in once before the session, including impersonation if the team uses it. The page names each user by the role label the UI shows. If it fails, stop and report: do not change data to work around it.
- Passwords and tokens never go on the page or in the notes. Users are referred to by their seeded email.

## Values the driver needs

- Every id, URL and link the driver opens is printed by the setup script before the session and pasted into the page. No lookup in the middle of a scenario.
- A value that changes when the seed runs again is named as such, and the setup script reprints it.

## Console snippets

- Only for one-off fixes in the current environment. Anything the next session needs goes into the seed.
- Each snippet prints one labeled line for every result, not only the last value.
- Each snippet is safe to run twice.

## Surprises

Before the session, find every surprise the team could hit and write it in the Context line of the scenario where it shows, with its reason. Look for:

- Data stores that the test environment does not feed, so a screen is empty for every role.
- Existing production behavior the feature keeps on purpose, which looks like a bug to someone who did not read the spec.
- Real data present next to seeded data, so a list longer than the seed shows.
- Filters and lists that are wider than the feature, when the squad has not narrowed them yet.
- Gaps between two places that show the same fact differently, and which one is right.

Each one says what the driver will see, why, and what to do. Every surprise a past session hit was explainable but missing from the page; that is the failure this list prevents.
