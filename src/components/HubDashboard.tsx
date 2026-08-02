/** Hub dashboard (SUB-189): the column-first home-page renderer. The note
    body is ordinary markdown — `parseHub` (src/lib/hub.ts) splits it into
    section labels (`## `), card rows (consecutive callouts, laid out side by
    side in the `.dash-cards` grid — the columns) and linear markdown chunks.
    Everything renders read-only; the "Open source note" button drops into the
    editor, which stays the editing surface. */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { vaultRead } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { imageSource } from "../lib/assets";
import { isImageName } from "../lib/artwork";
import { parseHub, type HubCallout } from "../lib/hub";
import { DashHead, DashPrintButton } from "./DashHead";
import { optionColor, OptionPill } from "./SelectMenu";

interface HubDashboardProps {
  meta: NoteMeta;
  schema: SchemaConfig;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onFollowLink?: (name: string) => void;
}

interface Ctx {
  onFollowLink?: (name: string) => void;
  schema?: SchemaConfig;
}

/** Schema pill color for a hub-table cell: a status cell here and the same
    status in a database view must wear the same pill (design principle 4 —
    one concept, one treatment). The table is markdown, so the match is by
    column-header prop name across all type schemas, then by cell value —
    several types may share a prop name (task.status vs release.status), so
    the first schema whose OPTIONS actually hold the value decides. */
function cellPillColor(
  schema: SchemaConfig | undefined,
  header: string,
  value: string
): string | undefined {
  if (!schema) return undefined;
  const want = header.trim().toLowerCase();
  if (want === "" || value.trim() === "") return undefined;
  for (const props of Object.values(schema)) {
    for (const [name, ps] of Object.entries(props)) {
      if (name.toLowerCase() !== want) continue;
      const color = optionColor(ps.options, value);
      if (color !== undefined) return color;
    }
  }
  return undefined;
}

function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
}

/** The editor's cell-mark set (editor-widgets.ts CELL_MARK_RE) plus `![[...]]`
 *  embeds up front (print.ts order): wikilink, md-link, code, bold, italic,
 *  strike — bold/italic/strike recurse, code stays literal. No more. */
const INLINE_MARK_RE =
  /!\[\[([^[\]]+)\]\]|\[\[([^[\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g;

function Inline({ text, ctx }: { text: string; ctx: Ctx }): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  // per-render instance: Inline recurses, and a shared /g regex's lastIndex
  // would be clobbered by the inner call (same trap as renderCell)
  const re = new RegExp(INLINE_MARK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<DashEmbed key={k++} name={m[1].trim()} />);
    } else if (m[2] !== undefined) {
      const name = m[2].trim();
      out.push(
        <button
          type="button"
          key={k++}
          className="dash-link"
          onClick={() => ctx.onFollowLink?.(name)}
        >
          {name}
        </button>
      );
    } else if (m[3] !== undefined) {
      const url = m[4];
      out.push(
        <button
          type="button"
          key={k++}
          className="dash-link dash-extlink"
          onClick={() => openExternalLink(url)}
        >
          {m[3]}
        </button>
      );
    } else if (m[5] !== undefined) {
      out.push(
        <code key={k++} className="cm-inline-code">
          {m[5]}
        </code>
      );
    } else {
      const [Tag, body] =
        m[6] !== undefined
          ? (["strong", m[6]] as const)
          : m[7] !== undefined
            ? (["em", m[7]] as const)
            : (["s", m[8]] as const);
      out.push(
        <Tag key={k++}>
          <Inline text={body} ctx={ctx} />
        </Tag>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** `![[name]]` — images resolve like the print/gallery path (imageSource,
 *  which streams via the asset protocol in Tauri and synthesizes in the mock
 *  gate); a miss renders the standard missing text. Audio and other files
 *  render the print idiom's named placeholder — no players in dashboards. */
function DashEmbed({ name }: { name: string }) {
  const image = isImageName(name);
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!image) return;
    let gone = false;
    setSrc(null);
    setMissing(false);
    imageSource(name).then(
      (u) => {
        if (!gone) setSrc(u);
      },
      () => {
        if (!gone) setMissing(true);
      }
    );
    return () => {
      gone = true;
    };
  }, [name, image]);
  if (!image) return <span className="hub-embed">embedded file · {name}</span>;
  if (missing) return <span className="hub-missing">missing image · {name}</span>;
  if (!src) return null;
  return <img className="hub-img" src={src} alt={name} />;
}

/* ---- linear markdown chunks (print.ts block set, as React) --------------- */

const FENCE_OPEN_RE = /^```(\S*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const QUOTE_RE = /^\s*>/;
const QUOTE_STRIP_RE = /^\s*>\s?/;
const LIST_RE = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_BODY_RE = /^\[([ xX])\]\s+(.*)$/;

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableDivider = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

function renderBlocks(md: string, ctx: Ctx): ReactNode[] {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  let k = 0;
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(
        <p className="hub-p" key={k++}>
          {para.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              <Inline text={l} ctx={ctx} />
            </Fragment>
          ))}
        </p>
      );
      para.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_OPEN_RE.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(
        <pre className="hub-pre" key={k++}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      out.push(
        <div className="hub-heading" key={k++}>
          <Inline text={heading[2]} ctx={ctx} />
        </div>
      );
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      flushPara();
      out.push(<hr className="hub-hr" key={k++} />);
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]))
        quote.push(lines[i++].replace(QUOTE_STRIP_RE, ""));
      out.push(
        <blockquote className="hub-quote" key={k++}>
          {renderBlocks(quote.join("\n"), ctx)}
        </blockquote>
      );
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const head = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        rows.push(tableRow(lines[i++]));
      out.push(
        <table className="dash-table" key={k++}>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>
                  <Inline text={c} ctx={ctx} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, l) => {
                  // a plain cell that is a schema select value wears its
                  // option pill — the hub table and the database views speak
                  // one status language (design principle 4)
                  const color = cellPillColor(ctx.schema, head[l] ?? "", c);
                  return (
                    <td key={l}>
                      {color !== undefined ? (
                        <OptionPill color={color}>{c}</OptionPill>
                      ) : (
                        <Inline text={c} ctx={ctx} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      flushPara();
      const ordered = LIST_RE.exec(line)?.[2] !== undefined;
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM_RE.exec(lines[i]);
        if (!m) break;
        const task = TASK_BODY_RE.exec(m[1]);
        if (task) {
          // read-only in v1 — the source note is the editing surface
          const done = task[1] !== " ";
          items.push(
            <li className={`hub-task${done ? " done" : ""}`} key={items.length}>
              <input type="checkbox" checked={done} disabled readOnly />
              <span className="hub-task-text">
                <Inline text={task[2]} ctx={ctx} />
              </span>
            </li>
          );
        } else {
          items.push(
            <li key={items.length}>
              <Inline text={m[1]} ctx={ctx} />
            </li>
          );
        }
        i++;
      }
      out.push(
        ordered ? (
          <ol className="hub-list" key={k++}>
            {items}
          </ol>
        ) : (
          <ul className="hub-list" key={k++}>
            {items}
          </ul>
        )
      );
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

function MarkdownChunk({ text, ctx }: { text: string; ctx: Ctx }) {
  return <>{renderBlocks(text, ctx)}</>;
}

function HubCard({ callout, ctx }: { callout: HubCallout; ctx: Ctx }) {
  return (
    <div className={`dash-card hub-card hub-card-${callout.kind}`}>
      <div className="hub-card-title">
        {callout.title !== "" ? <Inline text={callout.title} ctx={ctx} /> : callout.kind}
      </div>
      {callout.body.length > 0 && (
        <div className="hub-card-body">{renderBlocks(callout.body.join("\n"), ctx)}</div>
      )}
    </div>
  );
}

export default function HubDashboard({
  meta,
  schema,
  vaultEpoch,
  onOpenSource,
  onFollowLink,
}: HubDashboardProps) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    vaultRead(meta.path).then((c) => {
      if (!gone) setBody(c.body);
    });
    return () => {
      gone = true;
    };
  }, [meta.path, vaultEpoch]);

  const blocks = useMemo(() => (body !== null ? parseHub(body) : []), [body]);
  const ctx = useMemo(() => ({ onFollowLink, schema }), [onFollowLink, schema]);

  if (body === null) return <div className="note" />;

  const cardCount = blocks.reduce((n, b) => n + (b.kind === "cards" ? b.callouts.length : 0), 0);
  const sectionCount = blocks.filter((b) => b.kind === "section").length;

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            label: `${sectionCount} ${sectionCount === 1 ? "section" : "sections"} · ${cardCount} ${
              cardCount === 1 ? "card" : "cards"
            }`,
          }}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        <div className="hub-body">
          {blocks.map((b, i) => {
            if (b.kind === "section")
              return (
                <div className="dash-section-label" key={i}>
                  <Inline text={b.text} ctx={ctx} />
                </div>
              );
            if (b.kind === "cards")
              return (
                <div className="dash-cards hub-cards" key={i}>
                  {b.callouts.map((c, j) => (
                    <HubCard key={j} callout={c} ctx={ctx} />
                  ))}
                </div>
              );
            return <MarkdownChunk key={i} text={b.text} ctx={ctx} />;
          })}
        </div>
      </div>
    </div>
  );
}
