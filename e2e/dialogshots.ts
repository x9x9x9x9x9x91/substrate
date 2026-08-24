import type { Page } from "@playwright/test";

/** The share dialog, shot on both grounds — one implementation, because it is
    one dialog. Lens and the return slip both shoot `.lens-dialog`; they only
    ever differed in the filename they wrote to, so a fix to how the box is
    captured now lands once instead of twice.

    Dark is the OVERLAY, not the box: `--bg-elevated` is translucent by design
    (window opacity), so an element shot of the box alone shows the note behind
    it and reads as a rendering bug that is not there. Light is the box cloned
    into the print surface — the overlay is a fixed full-viewport scrim and does
    not clone into a block usefully.

    `dir` is the shot directory, `prefix` the filename stem each caller writes
    under; the pair produces `<dir>/<prefix>-<name>-dark.png` and `-light.png`. */
export function dialogShooter(dir: string, prefix: string) {
  return async function shootDialog(page: Page, name: string) {
    // Settled, not mid-fade. `.overlay` fades in over 110ms and the box behind
    // it slides; a shot taken before those finish reads as a translucent panel
    // with the table showing through, which is a layout judgement the reviewer
    // cannot make. Waiting on the animations themselves rather than a guessed
    // timeout, so this stays true if the easing changes.
    await page.evaluate(
      async () =>
        await Promise.all(
          document.getAnimations().map((a) => a.finished.catch(() => undefined))
        )
    );
    await page.locator(".overlay").screenshot({
      path: `${dir}/${prefix}-${name}-dark.png`,
      animations: "disabled",
    });
    await page.evaluate(() => {
      const found = document.querySelector(".lens-dialog");
      if (!found) throw new Error("no .lens-dialog to clone");
      /* Inside the share door `.lens-dialog` is the `display: contents` wrapper:
         it generates no box of its own, so its rect is 0-wide and the frame this
         shot is of — the door's `.dbform` — is its ANCESTOR, not something
         inside it. Cloning the frame gets the real rendered box in both shapes;
         standalone, `.lens-dialog` IS the `.dbform` and `closest` returns it. */
      const target = found.closest(".dbform") ?? found;
      const box = target.getBoundingClientRect();
      const clone = target.cloneNode(true) as HTMLElement;
      // A cloned <select> does not carry its selection — the property is a live
      // DOM state, not an attribute — so the light shot of "writing a question"
      // used to read "Choose a property…" beside a written question, a state the
      // UI refuses. Stamp the live value onto the clone's markup.
      const selects = [...target.querySelectorAll("select")];
      [...clone.querySelectorAll("select")].forEach((copy, i) => {
        const live = selects[i];
        if (!live) return;
        for (const option of copy.querySelectorAll("option"))
          if (option.getAttribute("value") === live.value) option.setAttribute("selected", "");
      });
      clone.style.width = `${Math.round(box.width)}px`;
      clone.style.marginTop = "0";
      const surface = document.createElement("div");
      surface.id = "print-surface";
      surface.appendChild(clone);
      document.body.appendChild(surface);
    });
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(200);
    await page.locator("#print-surface").screenshot({ path: `${dir}/${prefix}-${name}-light.png` });
    await page.emulateMedia({ media: null });
    await page.evaluate(() => document.getElementById("print-surface")?.remove());
  };
}
