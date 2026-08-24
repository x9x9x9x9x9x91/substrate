---
type: dashboard
dashboard: hub
pages:
- label: Forecast
  note: Forecast
- label: Budgets
  note: Budgets
- label: Who Owes Whom
  note: Who Owes Whom
- label: Accounts
  note: Accounts
- label: Expected Returns
  note: Expected Returns
- label: Expenses
  note: Expenses
- label: Budget Limits
  note: Budget Limits
- label: Debts
  note: Debts
- label: Upcoming
  note: Upcoming
- label: Forecast Cashflow
  note: Forecast Cashflow
- label: Forecast Net Worth
  note: Forecast Net Worth
created: 2026-08-18
---
A personal-finance workbook. This page is the front door; the strip along the
bottom switches to the other boards and to every sheet behind them (⌃⇥ / ⌃⇧⇥
cycles). Nothing here is a special file type — it is twelve markdown notes
reading each other: four boards and the eight sheets behind them.

```cards
- label: Net worth
  bind: "{{Accounts.total_eur}}"
  format: eur
  emph: true
- label: Income / mo
  bind: "{{Expenses.income_monthly}}"
  format: eur
- label: Net / mo planned
  bind: "{{Expenses.net_monthly_plan}}"
  format: eur
  emph: true
- label: Going out in 14 days
  bind: "{{Upcoming.due_14d}}"
  format: eur
```

The last card is outflows only — bills plus the debts you owe. What is coming
*in* has its own card on [[Who Owes Whom]]; [[Upcoming]] keeps the two
directions apart rather than netting them into one misleading number.

## What you edit, and what the machine edits

Five sheets are **yours**. Type in them, and everything above recomputes:

> [!note] Accounts
> One row per account, with the balance in its own currency and a rate to euro.
> [!note] Expected Returns
> What each account is assumed to earn, split into payout and price growth.
> [!note] Expenses
> The fixed monthly costs, plus your take-home pay.
> [!note] Budget Limits
> A monthly limit per spending category.
> [!note] Debts
> Money between you and people you know, in either direction.

Three sheets are **the machine's**. Every one opens with a warning callout, and
a refresh script rewrites them whole:

> [!warn] Forecast Cashflow
> Twelve months of income, fixed costs, spending and net, in long form.
> [!warn] Forecast Net Worth
> Forty quarters of net worth, compounded forward.
> [!warn] Upcoming
> Every dated movement, swept out of Expenses and Debts, each row marked as
> money going out or coming in.

The split is not tidiness. The sheet engine has no row generation, no reading
of the previous row, and no exponentiation — so a compounding curve or a
twelve-month projection cannot be a formula, and has to arrive as rows. What
formulas do well is total, filter and compare what already exists, and every
summary those three sheets carry is a live formula over their own rows. Same
division of labour the annual-report recipe uses, one size up.

Three bindings worth tracing before you adapt this:

- [[Expected Returns]] reads a balance out of [[Accounts]] with a row-scoped
  `LOOKUP`, so a balance is written once and referenced everywhere.
- [[Debts]] holds no date arithmetic at all, because an undated tab is a real
  debt and `due - TODAY()` errors on a blank cell. The dated rows are swept
  into [[Upcoming]], which by construction has no blank dates — and which owns
  the `columns:` notification setting, so a bill alerts once and from one place.
- [[Upcoming]] carries a `flow` column, `out` or `in`, and every summary picks a
  side: what is due is the outflows, what is arriving is its own number. A sheet
  that mixes a repayment into the same total as the rent reports a smaller bill
  than you have.

## Making it recurring

The workbook is only alive if something refreshes it. One small script, run
once a day, does five things:

1. **Prices** (optional) — fetch each broker position's current value and write
   `value_native` back into [[Accounts]]. Skip this and the sheet is simply
   hand-maintained; nothing else breaks.
2. **Spending** — recompute the `spent_eur` column in [[Budget Limits]] from
   wherever your real spending lives: a bank CSV export, a receipts folder, a
   ledger file. Only that column; the limits beside it are yours.
3. **Dates** — rebuild [[Upcoming]] from the [[Expenses]] rows that carry a
   `due_day` and the dated open rows in [[Debts]], each resolved to its next
   occurrence, and mark each row `out` or `in`. A blank `due_day` is never swept.
4. **Curves** — regenerate [[Forecast Cashflow]] (twelve months, four series)
   and [[Forecast Net Worth]] (forty quarters), and write `net_median` into the
   cashflow sheet as a constant, since the formula language has no median.
5. **Stamp** — rewrite `exported:` in the frontmatter of all three machine
   sheets with the run's timestamp. That one line is what makes the next
   section possible: a sheet full of plausible numbers cannot tell you it
   stopped being refreshed, and a stamp can.

### Schedule it with launchd (macOS)

Write the plist, load it, and watch the log — a file and three commands.
Substitute `/Users/you` throughout for your own home directory; launchd takes
no `~` and no `$HOME` in these paths, so every one of them has to be spelled
out in full. The plist runs `/usr/bin/python3` directly, so the script needs no
execute bit; on a fresh Mac that path only exists once the Command Line Tools
are installed (`xcode-select --install`), and a job that fails silently at 6:10
is usually this. If your python lives somewhere else — Homebrew, pyenv, a venv
— `which python3` prints the path to put in the plist instead.

```xml
<!-- ~/Library/LaunchAgents/com.example.finance-refresh.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.finance-refresh</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/you/bin/finance-refresh.py</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>10</integer></dict>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/finance-refresh.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/finance-refresh.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>VAULT_DIR</key><string>/Users/you/Vault</string></dict>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.finance-refresh.plist
launchctl kickstart -p gui/$(id -u)/com.example.finance-refresh   # run it once, now
tail -f ~/Library/Logs/finance-refresh.log
```

`bootout` is the undo (`launchctl bootout gui/$(id -u)/com.example.finance-refresh`),
and re-running `bootstrap` after editing the plist needs that `bootout` first.

### Or cron (Linux)

One line, same job:

```sh
10 6 * * * mkdir -p "$HOME/.local/state" && VAULT_DIR=$HOME/Vault /usr/bin/python3 $HOME/bin/finance-refresh.py >> $HOME/.local/state/finance-refresh.log 2>&1
```

### Or hand it to your agent

You do not have to write the script. Open this note beside your agent and say:
*"write refresh.py against these files and schedule it daily."* The contract it
needs is short enough to state in full. Every path in it is vault-relative —
resolve them against `VAULT_DIR`, never against the working directory the job
happens to start in:

- **Reads, never writes:** `Finance/Expenses.md`, `Finance/Debts.md`,
  `Finance/Expected Returns.md`, and `Finance/Accounts.md` — which the net-worth
  curve starts from. `total_eur` there is a computed summary, not a stored
  number: nothing writes it into the file, so the script has to recompute it
  itself as `SUM(value_native × fx_to_eur)` over the rows.
- **Reads and writes, one column each way:** `Finance/Budget Limits.md`. Read
  `category` and `monthly_limit_eur`; write `spent_eur` and nothing else. The
  limits are the user's — a refresh that rewrites a limit has overwritten a
  decision, not refreshed a number. `value_native` in `Finance/Accounts.md` is
  the other single-column write, and it is optional.
- **The sweep rule:** a `Finance/Expenses.md` row with a `due_day` goes into
  `Finance/Upcoming.md` at its next occurrence of that day of the month; a row
  with `due_day` blank never does. Don't infer a date for a blank one. Dated
  open rows in `Finance/Debts.md` are swept too, at their own date.
- **The direction rule:** every `Finance/Upcoming.md` row carries `flow`, `out`
  for money leaving (a bill, or a debt with `direction: I owe`) and `in` for
  money arriving (`direction: owes me`). Outflow summaries filter on it; a row
  written without it lands in neither total.
- **Writes the whole file:** `Finance/Forecast Cashflow.md`,
  `Finance/Forecast Net Worth.md`, `Finance/Upcoming.md` — frontmatter,
  callout, prose and both fences. Keep the warning callout and the
  `columns:` map on Upcoming; they are contract, not decoration. A wholesale
  rewrite still carries the note's existing `created:` line through unchanged —
  it dates the note, not the export, and resetting it to today loses the only
  record of when the sheet began.
- **Stamps every run:** rewrite `exported:` in the frontmatter of all three
  machine-written sheets with the run's time, as an ISO timestamp. A liveness
  check reads that line and nothing else — it is how a stalled job is told
  apart from a quiet week.
- **Formats:** a sheet is a note with a ` ```csv ` fence and a ` ```formulas `
  fence. Dates are ISO days. Numbers are plain, no thousands separators, dot
  decimal. Column order is free; header names are matched case-insensitively.
- **Never invents a summary name.** The dashboards bind by name, so a renamed
  summary is a broken card. Change the name in both places or neither.
- **Writes atomically** — temp file, then rename — so the app's watcher never
  reads a half-written sheet.

## Watching the job afterwards

A scheduled job that quietly stops is worse than no job, because the numbers
still look like numbers. The stamp is what makes the difference readable: each
run rewrites `exported:` on [[Upcoming]], [[Forecast Cashflow]] and
[[Forecast Net Worth]], so the sheets carry the age of their own contents.

Read that age rather than the scheduler's verdict: loaded and last-exit-0 is
not the same as fresh — a job that runs, throws early and exits clean looks
perfect from the scheduler's side and leaves the stamp untouched. On a daily
refresh, a stamp older than about a day is the signal to go looking, whether
you check it by eye or wire it into whatever watches your machine's jobs.
