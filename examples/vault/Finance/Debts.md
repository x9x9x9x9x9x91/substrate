---
type: sheet
title: Debts
created: 2026-08-18
---
Yours to edit. Small money between you and people you know — the split bill, the
loan, the running tab. `direction` is written from your side: `owes me` or
`I owe`. `status` is `open` or `settled`; a settled row stays for the record and
drops out of every total.

`due` is optional here on purpose. A tab with no date is still a real debt, and
the formulas below never touch the column, so a blank cell can't error a
summary. Everything that needs date arithmetic — days left, overdue, what falls
due this fortnight — happens in [[Upcoming]], which the refresh script fills
with only the dated rows. That is the whole reason the two sheets are separate.

```csv
name,who,direction,amount_eur,due,status,notes
Concert tickets,Alex,owes me,84,2026-10-02,open,split four ways
Shared groceries,Sam,owes me,36.50,,open,running tab
Bike repair loan,Robin,I owe,150,2026-08-28,open,pay by bank transfer
Birthday dinner,Alex,I owe,22,,settled,cleared in cash
```

```formulas
owed_to_me = SUMIF(direction, "owes me", amount_eur, status, "open")
i_owe      = SUMIF(direction, "I owe", amount_eur, status, "open")
net_eur    = owed_to_me - i_owe
open_items = COUNTIF(status, "open")

settled_items = COUNTIF(status, "settled")
logged_items  = COUNTIF(name, "*")
```
