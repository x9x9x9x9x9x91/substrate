import { useEffect, useState } from "react";
import { cookbookIndex, cookbookInstall, cookbookShot } from "../lib/ipc";
import { expectsLine, parseCookbook, type CookbookRecipe } from "../lib/cookbook";
import type { CookbookInstall } from "../lib/types";
import { DashHead } from "./DashHead";

/* The in-app dashboard cookbook. The recipes ship inside the app
   bundle — this pane reads them over IPC and copies the chosen one into the
   vault. There is deliberately no network path here: what you can browse is
   what the installed version shipped with.

   Install never overwrites. A recipe file whose path is already taken lands
   beside it as `<stem> (cookbook).md`, and the success state names both, so a
   second install of the same recipe reads as a copy rather than a silent
   no-op. */

interface CookbookPaneProps {
  /** click-through to the installed dashboard */
  onOpenNote: (path: string) => void;
}

export default function CookbookPane({ onOpenNote }: CookbookPaneProps) {
  const [recipes, setRecipes] = useState<CookbookRecipe[] | null>(null);
  const [shots, setShots] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, CookbookInstall>>({});
  const [installErr, setInstallErr] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    cookbookIndex()
      .then((json) => {
        if (!live) return;
        const book = parseCookbook(json);
        setRecipes(book.recipes);
        // the shots are bundled next to the index — a missing one leaves the
        // card without a thumbnail rather than failing the whole pane
        for (const r of book.recipes) {
          if (!r.shot) continue;
          cookbookShot(r.shot)
            .then((b64) => {
              if (live) setShots((s) => ({ ...s, [r.id]: `data:image/png;base64,${b64}` }));
            })
            .catch(() => {});
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const install = (r: CookbookRecipe) => {
    setBusy(r.id);
    setInstallErr((m) => {
      const { [r.id]: _drop, ...rest } = m;
      return rest;
    });
    cookbookInstall(r.id, r.files)
      .then((res) => setInstalled((m) => ({ ...m, [r.id]: res })))
      .catch((e) => setInstallErr((m) => ({ ...m, [r.id]: String(e) })))
      .finally(() => setBusy(null));
  };

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title="Cookbook"
          state={recipes ? { label: `${recipes.length} recipes` } : null}
        />

        <p className="cb-about">
          Dashboard recipes that ship inside the app. Installing one copies its plain
          markdown files into this vault — the dashboard note plus the sheets and notes
          it reads — so it renders with numbers the first time you open it. Nothing here
          reaches the network, and an existing note is never overwritten.
        </p>

        {error && <div className="sync-action-err">{error}</div>}

        {/* No loading state: the recipes ship inside the bundle, so the read is
            one local file and the cards land in the same frame the head and the
            copy above do. A line that mounts and unmounts again would be the
            only thing that ever moved here. */}
        {recipes?.map((r) => {
          const done = installed[r.id];
          const expects = expectsLine(r);
          return (
            <section key={r.id} className="cb-recipe" data-recipe={r.id}>
              {shots[r.id] && (
                <img className="cb-shot" src={shots[r.id]} alt={`${r.title} dashboard`} />
              )}
              <div className="cb-body">
                <h2 className="cb-title">
                  <span>{r.title}</span>
                  <span className="cb-kind">{r.kind}</span>
                </h2>
                <p className="cb-blurb">{r.blurb}</p>
                <p className="cb-adapt">{r.adapt}</p>
                {expects && <p className="cb-expects">binds to {expects}</p>}

                {done ? (
                  <div>
                    <div className="cb-done-head">
                      Installed {done.files.length} {done.files.length === 1 ? "file" : "files"}
                    </div>
                    <ul className="cb-files">
                      {done.files.map((f) => (
                        <li key={f.path} className="cb-file">
                          <span className="cb-file-path">{f.path}</span>
                          {f.renamed_from && (
                            <span className="cb-file-note">
                              — {f.renamed_from} was already here, so this landed beside it
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {done.open && (
                      <button
                        type="button"
                        className="sheet-tool cb-open"
                        onClick={() => onOpenNote(done.open as string)}
                      >
                        Open the dashboard
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sheet-tool cb-install"
                    disabled={busy === r.id}
                    onClick={() => install(r)}
                  >
                    {busy === r.id ? "Installing…" : "Install"}
                  </button>
                )}
                {installErr[r.id] && <div className="sync-action-err">{installErr[r.id]}</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
