// Strict validation of a deck's sidecar attachments (speaker notes and media
// embedded in the PDF), for the checker page (client/src/lib/inspectAttachments.ts)
// and POST /api/check (server/routes/check.ts). Unlike the notes and media
// plugins' readers, which silently skip a bad attachment for the presenter,
// this reports every issue so the author can fix their source.
//
// The formats are described by schema/notes-sidecar.schema.json and
// schema/media-sidecar.schema.json.

import { notesToMarkdown } from "./typstNotes.js";

export type Validity = "valid" | "warning" | "invalid";

export interface SidecarIssue {
  level: "error" | "warning";
  message: string;
}

export type SidecarKind = "notes" | "media-json" | "media-binary" | "unknown";

export interface SidecarAttachment {
  filename: string;
  kind: SidecarKind;
  /** The page it's for, from its filename, when that's a page of the deck. */
  slide?: number;
  validity: Validity;
  issues: SidecarIssue[];
  content: Uint8Array;
  /** The parsed JSON (notes and media JSON that parse). */
  parsed?: unknown;
  /** The notes, as markdown (notes that render). */
  notes?: string;
}

export interface SidecarPage<A> {
  page: number;
  notes: A | null;
  media: A[];
}

export interface SidecarReport<A = SidecarAttachment> {
  pageCount: number;
  pages: SidecarPage<A>[];
  /** Attachments not associated with any page (unreferenced binaries,
   *  unknown filenames, slides outside the deck). */
  orphans: A[];
  /** Every binary media attachment, by filename. */
  binaries: Map<string, A>;
  /** Over the page attachments and the orphans (binaries only when orphaned). */
  summary: { total: number; valid: number; warning: number; invalid: number };
}

export const NOTES_FILE_RE = /^notes-slide-(\d+)\.json$/;
export const MEDIA_JSON_FILE_RE = /^media-slide-(\d+)-(.+)\.json$/;
export const MEDIA_BINARY_FILE_RE = /^media-.+\.(gif|mp4|webm)$/i;

const MEDIA_KINDS = new Set(["file", "url", "youtube", "vimeo"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validityOf(issues: SidecarIssue[]): Validity {
  if (issues.some((i) => i.level === "error")) return "invalid";
  if (issues.some((i) => i.level === "warning")) return "warning";
  return "valid";
}

/** The page a sidecar's filename names, checked against the deck. */
function slideFromFilename(filename: string, re: RegExp, pattern: string, pageCount: number, issues: SidecarIssue[]): number | undefined {
  const match = filename.match(re);
  if (!match) {
    issues.push({ level: "error", message: `Filename does not match ${pattern}` });
    return undefined;
  }
  const slide = parseInt(match[1], 10);
  if (slide < 1 || slide > pageCount) {
    issues.push({ level: "error", message: `Slide ${slide} is out of range (1–${pageCount})` });
    return undefined;
  }
  return slide;
}

/** The attachment's JSON object, or null with the reason added to `issues`. */
function parseJsonObject(content: Uint8Array, issues: SidecarIssue[]): { parsed: unknown; object: Record<string, unknown> | null } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    issues.push({ level: "error", message: "Content is not valid UTF-8" });
    return { parsed: undefined, object: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    issues.push({ level: "error", message: "Not valid JSON" });
    return { parsed: undefined, object: null };
  }
  if (!isRecord(parsed)) {
    issues.push({ level: "error", message: "Must be a JSON object" });
    return { parsed, object: null };
  }
  return { parsed, object: parsed };
}

export function checkNotesSidecar(filename: string, content: Uint8Array, pageCount: number): SidecarAttachment {
  const issues: SidecarIssue[] = [];
  const slide = slideFromFilename(filename, NOTES_FILE_RE, "notes-slide-{N}.json", pageCount, issues);
  const { parsed, object: data } = parseJsonObject(content, issues);
  let notes: string | undefined;

  if (data) {
    if (!("notes" in data)) {
      issues.push({ level: "error", message: 'Missing required "notes" field' });
    } else if (typeof data.notes !== "string" && (typeof data.notes !== "object" || data.notes === null)) {
      issues.push({ level: "error", message: '"notes" must be a string, array, or Typst AST object' });
    } else {
      const named = filename.match(NOTES_FILE_RE);
      if (named && data.slide !== undefined) {
        const fromField = parseInt(String(data.slide), 10);
        const fromName = parseInt(named[1], 10);
        if (!isNaN(fromField) && fromField !== fromName) {
          issues.push({ level: "warning", message: `"slide" field (${fromField}) disagrees with filename (${fromName})` });
        }
      }
      try {
        notes = notesToMarkdown(data.notes);
      } catch {
        issues.push({ level: "warning", message: "Could not render notes preview (AST may be non-standard)" });
      }
    }
  }

  return { filename, kind: "notes", slide, validity: validityOf(issues), issues, content, parsed, notes };
}

export function checkMediaSidecar(
  filename: string,
  content: Uint8Array,
  pageCount: number,
  attachmentNames: Set<string>
): SidecarAttachment {
  const issues: SidecarIssue[] = [];
  const slide = slideFromFilename(filename, MEDIA_JSON_FILE_RE, "media-slide-{N}-{id}.json", pageCount, issues);
  const { parsed, object: m } = parseJsonObject(content, issues);

  if (m) {
    for (const field of ["id", "mime", "slide"] as const) {
      if (m[field] === undefined) issues.push({ level: "error", message: `Missing required field "${field}"` });
    }
    for (const field of ["x_pt", "y_pt", "w_pt", "h_pt"] as const) {
      if (typeof m[field] !== "number") issues.push({ level: "error", message: `"${field}" must be a number` });
    }
    if (typeof m.w_pt === "number" && m.w_pt <= 0) issues.push({ level: "error", message: '"w_pt" must be > 0' });
    if (typeof m.h_pt === "number" && m.h_pt <= 0) issues.push({ level: "error", message: '"h_pt" must be > 0' });

    const inferred = m.url ? "url" : "file";
    if (m.kind !== undefined && !MEDIA_KINDS.has(m.kind as string)) {
      issues.push({ level: "error", message: `"kind" must be one of: file, url, youtube, vimeo` });
    } else if (!m.kind) {
      issues.push({ level: "warning", message: `"kind" not set; inferred as "${inferred}"` });
    }
    const kind = MEDIA_KINDS.has(m.kind as string) ? (m.kind as string) : inferred;

    if (kind === "file") {
      if (!m.filename) {
        issues.push({ level: "error", message: '"filename" is required for kind "file"' });
      } else if (!attachmentNames.has(m.filename as string)) {
        issues.push({ level: "error", message: `Binary attachment "${m.filename}" not found in PDF` });
      } else if (!MEDIA_BINARY_FILE_RE.test(m.filename as string)) {
        issues.push({
          level: "warning",
          message: `"filename" "${m.filename}" does not match expected media-{id}.{gif|mp4|webm} pattern`,
        });
      }
    } else {
      if (!m.url) issues.push({ level: "error", message: `"url" is required for kind "${kind}"` });
      if ((kind === "youtube" || kind === "vimeo") && !m.video_id) {
        issues.push({ level: "warning", message: '"video_id" missing — embed may not work' });
      }
    }
  }

  return { filename, kind: "media-json", slide, validity: validityOf(issues), issues, content, parsed };
}

/** The binaries media JSON attachments point at (their "filename"). */
function referencedBinaries(entries: { filename: string; content: Uint8Array }[]): Set<string> {
  const referenced = new Set<string>();
  for (const { filename, content } of entries) {
    if (!MEDIA_JSON_FILE_RE.test(filename)) continue;
    try {
      const m: unknown = JSON.parse(new TextDecoder().decode(content));
      if (isRecord(m) && typeof m.filename === "string") referenced.add(m.filename);
    } catch {
      // Reported when the attachment itself is checked.
    }
  }
  return referenced;
}

/** Check every attachment of a deck with `pageCount` pages. */
export function checkSidecars(entries: { filename: string; content: Uint8Array }[], pageCount: number): SidecarReport {
  const names = new Set(entries.map((e) => e.filename));
  const referenced = referencedBinaries(entries);
  const notesBySlide = new Map<number, SidecarAttachment>();
  const mediaBySlide = new Map<number, SidecarAttachment[]>();
  const binaries = new Map<string, SidecarAttachment>();
  const orphans: SidecarAttachment[] = [];

  for (const { filename, content } of entries) {
    if (NOTES_FILE_RE.test(filename)) {
      const a = checkNotesSidecar(filename, content, pageCount);
      if (a.slide !== undefined) notesBySlide.set(a.slide, a);
      else orphans.push(a);
    } else if (MEDIA_JSON_FILE_RE.test(filename)) {
      const a = checkMediaSidecar(filename, content, pageCount, names);
      if (a.slide !== undefined) mediaBySlide.set(a.slide, [...(mediaBySlide.get(a.slide) ?? []), a]);
      else orphans.push(a);
    } else if (MEDIA_BINARY_FILE_RE.test(filename)) {
      const issues: SidecarIssue[] = referenced.has(filename)
        ? []
        : [{ level: "warning", message: "No media JSON attachment references this file" }];
      const a: SidecarAttachment = { filename, kind: "media-binary", validity: validityOf(issues), issues, content };
      binaries.set(filename, a);
      if (!referenced.has(filename)) orphans.push(a);
    } else {
      orphans.push({
        filename,
        kind: "unknown",
        validity: "warning",
        issues: [{ level: "warning", message: "Unrecognized attachment — not a Presio sidecar" }],
        content,
      });
    }
  }

  const pages = Array.from({ length: pageCount }, (_, i) => ({
    page: i + 1,
    notes: notesBySlide.get(i + 1) ?? null,
    media: mediaBySlide.get(i + 1) ?? [],
  }));
  const all = [...notesBySlide.values(), ...[...mediaBySlide.values()].flat(), ...orphans];
  const summary = { total: all.length, valid: 0, warning: 0, invalid: 0 };
  for (const a of all) summary[a.validity]++;
  return { pageCount, pages, orphans, binaries, summary };
}
