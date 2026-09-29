import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate, useLocation, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf, loadPdfData, freshPdfUrl, loadLatestPdf, renderPageInto, clearCache, destroyPdf } from "@/lib/pdf";
import { loadDeck, type Deck } from "@/lib/deck";
import { useRenderTargetWidth } from "@/hooks/useRenderTargetWidth";
import { socket } from "@/lib/socket";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useSessionTransport } from "@/hooks/useSessionTransport";
import { useDeckWatch } from "@/hooks/useDeckWatch";
import { endSession, controllerHeaders } from "@/lib/sessionAuth";
import { idbGet, idbPut, idbDelete } from "@/lib/localStore";
import { isLocalDeckId } from "@/lib/localId";
import { RemoteDeckPoller } from "@/lib/remoteDeckPoller";
import { ConfirmDeckReloadDialog } from "@/components/controller/ConfirmDeckReloadDialog";
import { track } from "@/lib/analytics";
import { ingestPdfFile } from "@/lib/deckImport";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePluginHost } from "@/lib/plugins/usePluginHost";
import { ControllerView } from "./ControllerView";
import { ViewerView } from "./ViewerView";

export default function Presentation() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Set by Home when it navigates here right after replacing this deck's PDF
  // (see the initial load below). A timestamp, not a flag, so the cache-busted
  // URL is stable across reloads of this page.
  const replacedAt = (useLocation().state as { deckReplaced?: number } | null)?.deckReplaced;
  const requestedRole = searchParams.get("role") || "viewer";
  const [role, setRole] = useState(requestedRole);
  // The role once the session actually settles it — null while the request is
  // still in flight, since the server can hand back something other than what
  // the URL asked for. Only this drives analytics, never `requestedRole`.
  const [settledRole, setSettledRole] = useState<string | null>(null);
  const applyRole = useCallback((next: string) => {
    setRole(next);
    setSettledRole(next);
  }, []);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [currentSlide, setCurrentSlide] = useState(1);
  const [viewerSlide, setViewerSlide] = useState<number | null>(null);
  const [totalSlides, setTotalSlides] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blanked, setBlanked] = useState(false);

  // Everything extracted from the loaded PDF (links, attachments…),
  // re-derived whenever the document is swapped (e.g. after a notes edit).
  const [deck, setDeck] = useState<Deck | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    loadDeck(pdf, pdfUrl, filename).then((loaded) => {
      if (!cancelled) setDeck(loaded);
    });
    return () => { cancelled = true; };
  }, [pdf, pdfUrl, filename]);

  const currentCanvasRef = useRef<HTMLDivElement>(null);
  // Object URL backing a local session's PDF, swapped when notes are edited.
  const localUrlRef = useRef("");
  // Resolved during load: true if this presentation's PDF lives in this
  // browser's IndexedDB (local session). null until known.
  const [local, setLocal] = useState<boolean | null>(null);

  const isViewer = role === "viewer";
  const outOfSync = isViewer && viewerSlide !== null;
  const displaySlide = outOfSync ? viewerSlide! : currentSlide;

  const plugins = usePluginHost({
    id: id!,
    local,
    isPresenter: role === "controller",
    pdf,
    currentSlide: displaySlide,
    totalSlides,
  });

  // Mirror of pdfUrl for callbacks that must not re-run their effect when it
  // changes (a deck replace rewrites it on local sessions).
  const pdfUrlRef = useLatestRef(pdfUrl);

  // Edits a plugin saved into the deck (e.g. speaker notes) live in the
  // current PDF's bytes, so a recompiled or republished file replaces them.
  // Tracked to warn before that happens.
  const [deckEdited, setDeckEdited] = useState(false);

  // A URL-backed deck's source PDF was republished (see RemoteDeckPoller);
  // held until the presenter applies it or the poller replaces it with a
  // newer sighting. Null = nothing pending.
  const [remoteUpdate, setRemoteUpdate] = useState<{ totalSlides: number } | null>(null);
  // Whether the republish prompt is open, and whether it's being applied.
  const [remotePrompt, setRemotePrompt] = useState(false);
  const [applyingRemote, setApplyingRemote] = useState(false);
  // Whether pdfUrl points at someone else's host (a URL-backed deck) rather
  // than our own storage. Decides how a changed deck is re-fetched.
  const [externalPdf, setExternalPdf] = useState(false);
  const externalPdfRef = useLatestRef(externalPdf);
  // The republished deck, already downloaded and parsed by the poller to
  // confirm it. Handed to applyDeckUpdate so applying costs no second download.
  const prefetchedDeckRef = useRef<PDFDocumentProxy | null>(null);

  // The deck swap currently being loaded, if any. A replacement uploaded from
  // this window is announced to it twice — by the upload's own response and by
  // the server's `deck_updated` broadcast, the one every viewer acts on — and
  // both describe the same document. Keyed on that description so whichever
  // announcement lands first starts the swap and the other joins it rather
  // than downloading the same deck a second time. Cleared once the swap
  // settles, so a later announcement is never mistaken for this one.
  const deckSwapRef = useRef<{ key: string; done: Promise<void> } | null>(null);

  // Swap in a replacement deck: announced over the wire (socket `deck_updated`
  // for synced sessions, a BroadcastChannel `deck_update` for local ones) or by
  // the reply to this window's own replace. What plugins retained for the old
  // deck (retain: "deck" — drawings, keyed by slide number, which the new
  // document may renumber) is dropped wholesale, and they hear it's a new
  // document. Slide clamping needs no extra work here: the deck effect
  // adopts the new document's page count once it loads.
  const applyDeckUpdate = useCallback(
    ({ filename, totalSlides }: { filename: string; totalSlides: number }): Promise<void> => {
      const key = `${totalSlides}:${filename}`;
      const inFlight = deckSwapRef.current;
      if (inFlight?.key === key) return inFlight.done;

      setFilename(filename);
      plugins.host.forgetDeckRetained();
      // Whatever was saved into the deck here lived in the outgoing PDF's bytes.
      setDeckEdited(false);
      setTotalSlides(totalSlides);
      setCurrentSlide((slide) => Math.min(Math.max(slide, 1), totalSlides));
      const done = (async () => {
        try {
          if (local) {
            // Same-browser windows read the fresh record straight from IndexedDB.
            const rec = await idbGet(id!);
            if (!rec) return;
            const bytes = new Uint8Array(await rec.blob.arrayBuffer());
            const doc = await loadPdfData(bytes);
            setPdf(doc);
            const url = URL.createObjectURL(rec.blob);
            if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
            localUrlRef.current = url;
            setPdfUrl(url);
          } else {
            clearCache();
            // The remote-version poller already downloaded and parsed the
            // republished deck to confirm it. When this update is that one,
            // adopt the document it has rather than fetching the same bytes
            // again mid-presentation.
            const prefetched = prefetchedDeckRef.current;
            prefetchedDeckRef.current = null;
            if (prefetched && prefetched.numPages === totalSlides) {
              setPdf(prefetched);
              return;
            }
            destroyPdf(prefetched);
            const doc = await loadLatestPdf(pdfUrlRef.current, {
              external: externalPdfRef.current,
              version: Date.now(),
            });
            setPdf(doc);
          }
        } catch {
          // Keep showing the previous deck rather than a broken screen; the
          // stored row already describes the new one and a reload recovers.
        }
      })();
      deckSwapRef.current = { key, done };
      void done.finally(() => {
        if (deckSwapRef.current?.done === done) deckSwapRef.current = null;
      });
      return done;
    },
    [local, id, externalPdfRef, pdfUrlRef, plugins.host]
  );

  useEffect(() => {
    let cancelled = false;
    let localUrl = "";
    (async () => {
      try {
        // If the PDF is in this browser's IndexedDB, it's a local session —
        // render it without the server (works offline, independent of the row).
        const rec = await idbGet(id!).catch(() => {
          throw new Error("Couldn't read the presentation from this browser. Private/incognito mode isn't supported — please use a normal window.");
        });
        if (rec) {
          if (cancelled) return;
          setLocal(true);
          localUrl = URL.createObjectURL(rec.blob);
          localUrlRef.current = localUrl;
          const doc = await loadPdf(localUrl);
          if (cancelled) return;
          setPdfUrl(localUrl);
          setPdf(doc);
          setFilename(rec.filename);
          setTotalSlides(rec.totalSlides);
          return;
        }

        // A browser-local deck has no server row, so an id of that shape with
        // no record means the deck isn't here — not that the server might know
        // better. Say so instead of waiting out a lookup that can't succeed
        // (and, offline, can't even be attempted).
        if (isLocalDeckId(id!)) {
          throw new Error("This presentation is only available in the same browser on the device it was created on");
        }
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) throw new Error("Session not found");
        const session = await res.json();
        if (session.local) {
          // Server knows this code, but the PDF only lives on the presenter's device.
          throw new Error("This presentation is only available in the same browser on the device it was created on");
        }
        if (cancelled) return;
        setLocal(false);
        setExternalPdf(!!session.external);
        // Arriving straight from a replace (Home's recents/re-upload flow) the
        // stored object has new bytes at the same URL, and this browser is the
        // one most likely to have the old copy cached — it had the deck open
        // before. Viewers already in the room don't hit this: they get
        // deck_updated and reload through applyDeckUpdate, which busts too.
        // Keyed by the replace's own timestamp, so a reload of this page reuses
        // the fetch rather than starting another one.
        const doc = await loadPdf(
          replacedAt ? freshPdfUrl(session.pdfUrl, replacedAt) : session.pdfUrl
        );
        if (cancelled) return;
        // Store the canonical URL: later reloads append their own version.
        setPdfUrl(session.pdfUrl);
        setPdf(doc);
        setFilename(session.filename);
        setTotalSlides(session.total_slides);
        setCurrentSlide(session.current_slide);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load presentation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearCache();
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    };
    // replacedAt belongs here: replacing the same deck again from Home routes
    // back to this already-mounted page with a new timestamp, and that has to
    // reload the document rather than leave the previous one on screen.
  }, [id, replacedAt]);

  // The loaded document decides the page count: URL-backed decks re-fetch
  // their PDF on every load, so a republished file can change the page count
  // under a value stored at creation time. Adopt the document's count, pull
  // the current slide back into range, and refresh whatever stored count
  // remains (IndexedDB record / session row) so every device agrees.
  useEffect(() => {
    if (!deck) return;
    const docTotal = deck.totalSlides;
    if (totalSlides === docTotal) return;
    // Reconciling with the document itself, which only exists once it has
    // finished loading — there is no render-time value to derive this from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTotalSlides(docTotal);
    setCurrentSlide((slide) => Math.min(Math.max(slide, 1), docTotal));
    if (local) {
      idbGet(id!).then((rec) => {
        if (rec && rec.totalSlides !== docTotal) idbPut({ ...rec, totalSlides: docTotal });
      }).catch(() => { /* best effort */ });
    } else if (role === "controller") {
      // Only the controller can correct the stored row; viewers already show
      // the document-derived count either way.
      socket.emit("total_slides_change", { totalSlides: docTotal });
    }
  }, [deck, totalSlides, local, role, id]);

  useEffect(() => {
    if (!filename) return;
    const suffix = role === "controller" ? "Controller" : "Viewer";
    document.title = `${filename} - ${suffix}`;
    return () => { document.title = "Presio"; };
  }, [filename, role]);

  const clampSlide = useCallback((total: number) => {
    setCurrentSlide((slide) => Math.min(Math.max(slide, 1), total));
  }, []);
  const { channelRef, broadcast } = useSessionTransport(id!, local, requestedRole, {
    onRole: applyRole,
    onRoleChanged: (next) => {
      applyRole(next);
      setSearchParams({ role: next }, { replace: true });
    },
    onSlide: setCurrentSlide,
    onTotalSlides: (total) => {
      setTotalSlides(total);
      clampSlide(total);
    },
    onBlanked: setBlanked,
    onSessionState: (state) => {
      setCurrentSlide(state.currentSlide);
      setTotalSlides(state.totalSlides);
    },
    onStateSync: (state) => {
      setCurrentSlide(state.currentSlide);
      if (state.totalSlides) setTotalSlides(state.totalSlides);
      setBlanked(state.blanked);
    },
    onSyncAll: () => setViewerSlide(null),
    onDeckUpdate: (update) => void applyDeckUpdate(update),
    onError: setError,
    onEnded: () => navigate("/", { replace: true }),
    // The presenter shared this deck from another window. Its local record is
    // gone and the code the server minted is where it lives now, so follow it
    // — the alternative is a viewer left on an id that no longer resolves.
    onRekeyed: (next) => navigate(`/s/${next}?role=${requestedRole}`, { replace: true }),
    getState: () => ({ currentSlide, totalSlides, blanked }),
  });

  // Report the settled role to analytics. The `?role=` query param is already
  // in every tracked URL, but Umami's Pages report keys on the path alone, so
  // viewers and controllers collapse into one `/s/:id` row. A custom event
  // gives them their own breakdown. Fires once per role: reconnects re-settle
  // the same value, and only a real change (a controller demoted by
  // controller_replaced) counts as a second data point.
  const trackedRoleRef = useRef("");
  useEffect(() => {
    if (!settledRole) return;
    if (trackedRoleRef.current === settledRole) return;
    trackedRoleRef.current = settledRole;
    track("session-role", { role: settledRole, mode: local ? "local" : "server" });
  }, [settledRole, local]);

  // The canvas is rendered at the container's pixel size, so anything that
  // changes that size or scale — entering fullscreen, dragging the viewer onto
  // a projector, browser zoom, a move to a differently scaled monitor — has to
  // re-render, or the slide stays an upscaled canvas from the old size.
  const viewWidth = useRenderTargetWidth(currentCanvasRef, !!deck);

  useEffect(() => {
    if (!pdf || !currentCanvasRef.current || !viewWidth) return;
    const container = currentCanvasRef.current;
    // Cancelled on a slide change, so a late render of the old slide can't
    // land under plugins' layers already showing the new one.
    return renderPageInto(container, pdf, displaySlide, { targetWidth: viewWidth });
    // deck gates mounting of the view that owns the container, and refs
    // don't trigger effects — re-run once the container actually exists.
  }, [pdf, displaySlide, role, deck, viewWidth]);

  const goTo = useCallback(
    (slide: number) => {
      if (slide < 1 || slide > totalSlides) return;
      broadcast(
        { type: "slide_update", payload: { slideNumber: slide } },
        { event: "slide_change", payload: { slideNumber: slide } }
      );
      setCurrentSlide(slide);
    },
    [totalSlides, broadcast]
  );

  const viewerGoTo = useCallback(
    (slide: number) => {
      // Local viewers always follow the controller — no independent navigation.
      if (local) return;
      if (slide < 1 || slide > totalSlides) return;
      setViewerSlide(slide);
    },
    [totalSlides, local]
  );

  const resync = useCallback(() => setViewerSlide(null), []);

  const syncAll = useCallback(() => { if (!local) socket.emit("sync_all"); }, [local]);

  const endPresentation = useCallback(async () => {
    if (local) {
      await idbDelete(id!).catch(() => { /* ignore */ });
      channelRef.current?.postMessage({ type: "session_ended" });
    } else {
      await endSession(id!);
    }
    navigate("/", { replace: true });
  }, [local, id, navigate, channelRef]);

  // Authorization for rewriting a synced deck's stored PDF.
  const pdfWriteAuth = useCallback(async (): Promise<Record<string, string>> => {
    const headers = await controllerHeaders(id!);
    if (!Object.keys(headers).length) {
      throw new Error("This browser isn't the controller for this presentation");
    }
    return headers;
  }, [id]);

  // Watch a URL-backed deck for republishes at its source (controller only).
  useEffect(() => {
    if (local !== false || role !== "controller") return;
    const url = pdfUrlRef.current;
    if (!url || url.startsWith("blob:")) return;
    const poller = new RemoteDeckPoller({
      id: id!,
      url,
      auth: pdfWriteAuth,
      onChange: (doc) => {
        // Keep it: if the presenter applies this update, applyDeckUpdate
        // adopts the document instead of downloading the same bytes again.
        destroyPdf(prefetchedDeckRef.current);
        prefetchedDeckRef.current = doc;
        setRemoteUpdate({ totalSlides: doc.numPages });
        setRemotePrompt(true);
      },
    });
    poller.start();
    return () => {
      poller.stop();
      destroyPdf(prefetchedDeckRef.current);
      prefetchedDeckRef.current = null;
    };
  }, [local, role, id, pdfUrl, pdfWriteAuth, pdfUrlRef]);

  // Pill click: announce the republished deck for controller and viewers via
  // the server's deck_updated broadcast — every client (this one included)
  // cache-busts the URL and reloads through the ordinary deck_updated path.
  const applyRemoteDeckUpdate = useCallback(async () => {
    if (!remoteUpdate || applyingRemote) return;
    setApplyingRemote(true);
    try {
      const authHeaders = await pdfWriteAuth();
      const res = await fetch(`/api/sessions/${id}/deck-refreshed`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ total_slides: remoteUpdate.totalSlides }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to apply the updated deck");
      }
      setRemoteUpdate(null);
      setRemotePrompt(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to apply the updated deck");
    } finally {
      setApplyingRemote(false);
    }
  }, [remoteUpdate, applyingRemote, id, pdfWriteAuth]);

  // Save an edited PDF over the deck (a plugin's presio.deck.save), then swap
  // in the updated document so further edits build on it. Local sessions
  // update IndexedDB; synced ones re-upload to the owner's stored PDF. Only
  // edits in place: a different page count is a replace, not an edit.
  const saveDeck = useCallback(
    async (updated: Uint8Array) => {
      if (!pdf) throw new Error("The deck hasn't loaded yet");
      // A copy: pdf.js transfers what it's given to its worker, detaching it.
      const doc = await loadPdfData(updated.slice()).catch(() => {
        throw new Error("That isn't a PDF Presio can open");
      });
      if (doc.numPages !== pdf.numPages) {
        throw new Error("An edited deck must keep the same slides");
      }
      // Coerce to a plain ArrayBuffer slice so Blob's BlobPart typing is happy.
      const buf = updated.buffer.slice(
        updated.byteOffset,
        updated.byteOffset + updated.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([buf], { type: "application/pdf" });

      if (local) {
        const rec = await idbGet(id!);
        if (rec) await idbPut({ ...rec, blob });
      } else {
        // Synced deck: re-upload to its server copy.
        const authHeaders = await pdfWriteAuth();
        const form = new FormData();
        form.append("pdf", blob, `${filename || "presentation"}.pdf`);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to save the deck");
        }
      }

      // These edits live in this PDF's bytes, so a recompiled file would drop
      // them. Remembered so the live-reload prompt can say so.
      setDeckEdited(true);

      // Same pages, edited: plugins keep what they hang off them.
      plugins.host.expectDeckEdit();
      setPdf(doc);
      if (local) {
        const url = URL.createObjectURL(blob);
        if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
        localUrlRef.current = url;
        setPdfUrl(url);
      }
    },
    [pdf, local, id, filename, pdfWriteAuth, plugins.host]
  );
  useEffect(() => {
    plugins.host.setDeckWriter(role === "controller" ? saveDeck : null);
  }, [plugins.host, role, saveDeck]);

  // Replace this presentation's PDF with a new file, keeping the session id,
  // code, controller token and passphrase. Mirrors saveNotes' local/synced
  // fork: local decks swap the IndexedDB record in place (nothing uploads);
  // synced ones re-upload to their stored object and let the server's
  // deck_updated broadcast drive the document swap on every client.
  const replacePdf = useCallback(
    async (file: File, handle?: FileSystemFileHandle) => {
      if (local === null) return;
      const { blob, sha256, totalSlides, filename, size } = await ingestPdfFile(file);

      if (local) {
        const rec = await idbGet(id!);
        if (!rec) throw new Error("This presentation is no longer in this browser");
        // A handle passed along (picked via showOpenFilePicker or read from
        // the watched file itself) replaces the stored one, so watching
        // follows the new file; without one the existing handle stays.
        await idbPut({ ...rec, blob, filename, totalSlides, sha256, ...(handle ? { handle } : {}) });
        channelRef.current?.postMessage({
          type: "deck_update",
          payload: { filename, totalSlides },
        });
        await applyDeckUpdate({ filename, totalSlides });
      } else {
        const authHeaders = await pdfWriteAuth();
        const form = new FormData();
        form.append("pdf", blob, `${filename}.pdf`);
        form.append("filename", filename);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Failed to replace the PDF");
        }
        // Swap the new deck in from this reply rather than waiting for the
        // server's `deck_updated` broadcast to come back around to us. That
        // broadcast is what moves the viewers, and it usually moves this
        // window too — but it is a single fire-and-forget message to the one
        // socket that just spent the upload saturating its connection, and a
        // missed one has no recovery: nothing re-announces a deck, so the
        // presenter stayed on the old slides until a manual reload while every
        // viewer had already moved on. Applying here needs no socket at all,
        // and the broadcast, when it does arrive, joins this same swap.
        await applyDeckUpdate({
          // The server's spelling of both, so the broadcast describing this
          // replace produces the identical key and coalesces with it.
          filename: typeof body.filename === "string" && body.filename ? body.filename : filename,
          totalSlides: typeof body.totalSlides === "number" ? body.totalSlides : totalSlides,
        });
      }

      track("deck-replace", {
        filename,
        sha256,
        size,
        slides: totalSlides,
        mode: local ? "local" : "server",
      });
    },
    [local, id, applyDeckUpdate, pdfWriteAuth, channelRef]
  );

  const deckWatch = useDeckWatch(id!, local, role === "controller", replacePdf);

  // The controller's own replace (picked or dropped file). A pick that came
  // with a file handle replaced the stored one, so watching follows it.
  const replaceFromController = useCallback(
    async (file: File, handle?: FileSystemFileHandle) => {
      await replacePdf(file, handle);
      if (handle) deckWatch.rewatch();
    },
    [replacePdf, deckWatch]
  );

  if (loading || (!error && !deck)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading presentation...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-4 text-center">
            <p className="text-3xl">😕</p>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{error}</h2>
              <p className="text-sm text-muted-foreground">
                The presentation may have expired or been ended by the presenter.
              </p>
            </div>
            <Button asChild className="w-full">
              <Link to="/">Back to Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (role === "viewer") {
    return (
      <ViewerView
        id={id!}
        local={!!local}
        deck={deck!}
        canvasRef={currentCanvasRef}
        blanked={blanked}
        currentSlide={displaySlide}
        outOfSync={outOfSync}
        onViewerGoTo={viewerGoTo}
        onResync={resync}
        plugins={plugins}
      />
    );
  }

  return (
    <>
      {/* A detected deck change waiting on the presenter: a recompile from the
          file watcher (prompt mode only) or a republish at the deck's URL.
          Never both: only local decks are watched, only synced ones polled.
          Either replaces the deck (dropping edits saved into it here, and
          what plugins hung off its slides), so both get the same warning. */}
      {(deckWatch.prompt || remotePrompt) && (
        <ConfirmDeckReloadDialog
          filename={filename}
          source={deckWatch.prompt ? "watch" : "remote"}
          deckEdited={deckEdited}
          busy={deckWatch.prompt ? deckWatch.applying : applyingRemote}
          onConfirm={deckWatch.prompt ? deckWatch.apply : applyRemoteDeckUpdate}
          // Dismissed, not declined: the header keeps the "Deck updated" chip
          // so the update can still be applied when the moment is right.
          onClose={() => {
            deckWatch.dismissPrompt();
            setRemotePrompt(false);
          }}
        />
      )}
      <ControllerView
        id={id!}
        local={!!local}
        deck={deck!}
        currentSlide={currentSlide}
        onGoTo={goTo}
        onSyncAll={syncAll}
        onEnd={endPresentation}
        onSynced={() => setLocal(false)}
        onReplacePdf={replaceFromController}
        currentCanvasRef={currentCanvasRef}
        blanked={blanked}
        filename={filename}
        deckUpdates={{
          mode: deckWatch.mode,
          status: deckWatch.status,
          onSetMode: deckWatch.setMode,
          onApply: deckWatch.apply,
          onResume: deckWatch.resume,
          remoteUpdate: !!remoteUpdate,
          onRemoteApply: applyRemoteDeckUpdate,
        }}
        onBlankToggle={() => {
          const next = !blanked;
          // Server mode learns the new state from the socket echo; local mode has
          // no echo (BroadcastChannel doesn't deliver to the sender), so set it here.
          if (local) setBlanked(next);
          broadcast({ type: "blank_update", payload: { blanked: next } }, { event: "blank_toggle" });
        }}
        plugins={plugins}
      />
    </>
  );
}
