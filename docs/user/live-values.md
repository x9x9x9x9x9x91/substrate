# Live values in prose

A number you keep in a sheet can appear in a sentence, and stay right.

Write the expression as inline code — a backtick, `=`, **one space**, then the
expression:

```markdown
The label has `= Masters.count` releases, worth `= Holdings.total`.
```

Substrate renders that as **The label has 205 releases, worth 300.900.** The
numbers come out of your `Masters` and `Holdings` sheets, and they update when
those sheets do — nothing to refresh, nothing to paste again.

The space after the `=` is the whole grammar, and it is there so writing *about*
formulas never turns into running them. `` `=SUM(A1:A2)` `` in a sentence about
Excel is text you wrote, and it stays exactly that.

## What you can write

Anything a sheet formula can say. `Sheet.name` reaches a summary or a column of
that sheet, and the usual functions work around it:

```markdown
Cash on hand: `= Cash.cash_total`
Half of it: `= ROUND(Cash.cash_total / 2)`
Everything together: `= Holdings.total + Cash.cash_total`
```

Values carrying units — currencies, kilos, milliseconds — read exactly as the
sheet shows them, units included. The conversion happens in the sheet, not in
the sentence: a sheet's `= 25 USD in EUR` gives you a column you can then pull
into prose, but writing that conversion inside the span itself doesn't work —
by the time a value reaches a sentence, its unit is part of the text.

A whole column is not an answer, so `` `= Holdings.value_eur` `` shows nothing
useful on its own. Wrap it: `SUM`, `COUNT`, `AVG`.

## Writing about the syntax itself

Double the backticks and nothing computes:

```markdown
Write it as ``= Masters.count`` to pull the number in.
```

That shows the expression as code, which is what you want in a sentence
explaining it. Same for anything inside a fenced code block or an indented
(four-space) one — code you are *showing* stays shown.

## What it does not do

Live values only read. An expression can never change a sheet, add a row, or
write anything back — including its own answer. Your file keeps the expression
you typed and nothing else, which is why the number is always current rather
than a snapshot of whenever you last looked.

That also means the note stays readable anywhere else. Open it in another
markdown editor and you see `= Masters.count` as code, in a sentence that still
makes sense.

## When a value cannot be worked out

You get a dim `–` instead of the number. Hover it for the reason — usually a
sheet that isn't there, or a name spelled differently than in the sheet. It
never breaks the sentence around it, and it never turns into an error message
in your text.

If what you wrote isn't an expression at all, you don't even get the dash: the
span simply stays the code span you typed, unchanged.
