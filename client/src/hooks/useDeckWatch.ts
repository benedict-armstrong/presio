import { useCallback, useEffect, useRef, useState } from "react";
import { idbGet } from "@/lib/localStore";
import { lsGetString, lsSetString, deckWatchKey } from "@/lib/storage";
import {
  DeckWatcher,
  isDeckWatchSupported,
  isDeckWatchMode,
  type DeckWatchMode,
  type DeckWatchStatus,
} from "@/lib/deckWatcher";
import { useLatestRef } from "./useLatestRef";

/**
 * Deck file watching (File System Access API, Chromium only). When a local
 * deck's IndexedDB record carries a handle to the deck's file on disk, the
 * controller polls it and offers a recompile through the header pill —
 * nothing swaps until the presenter clicks (or, in auto mode, right away).
 * Viewers don't watch: the controller applies the update on everyone's behalf.
 *
 * `isController` is the settled role, not the requested one: a second
 * controller demoted to viewer by session_state must stop watching too.
 * `replacePdf` is the ordinary replace path an accepted recompile goes through.
 */
export function useDeckWatch(
  id: string,
  local: boolean | null,
  isController: boolean,
  replacePdf: (file: File) => Promise<void>
) {
  const [status, setStatus] = useState<DeckWatchStatus | null>(null);
  const watcherRef = useRef<DeckWatcher | null>(null);
  const applyingRef = useRef(false);
  const [applying, setApplying] = useState(false);
  // Whether this deck's IndexedDB record carries a handle to a file on disk.
  // Until that's known the header shows no live-reload control at all rather
  // than a wrong one; whether the handle is any use right now is a separate,
  // derivable question (see `mode` below).
  const [hasHandle, setHasHandle] = useState(false);
  // Bumped when a replace stores a new file handle, so the effect below tears
  // the watcher down and re-reads the record — otherwise watching would stay
  // pinned to the previous file until a reload.
  const [handleEpoch, setHandleEpoch] = useState(0);
  // How the presenter wants recompiles handled. Chosen at upload (Home's
  // live-reload checkbox), changed from the header, and remembered per deck.
  const [mode, setMode] = useState<DeckWatchMode>(() => {
    const stored = lsGetString(deckWatchKey(id));
    return isDeckWatchMode(stored) ? stored : "prompt";
  });
  const modeRef = useLatestRef(mode);
  // A detected recompile waiting on the presenter (prompt mode only).
  const [prompt, setPrompt] = useState(false);

  const replaceRef = useLatestRef(replacePdf);

  // Swap the detected recompile in for controller and viewers via the
  // ordinary replace path (one presenter-side decision for everyone).
  const apply = useCallback(async () => {
    const watcher = watcherRef.current;
    if (!watcher || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      // Read the file as it is *now*: the version detected a moment ago has
      // usually been rewritten again by a watch-mode build, and its bytes no
      // longer read back.
      const update = await watcher.takeUpdate();
      if (!update) {
        window.alert("The deck file is still being written. Try again in a moment.");
        return;
      }
      await replaceRef.current(update.file);
      // Only move the reference point once the swap actually took, so a failed
      // replace leaves the update pending and the pill clickable.
      watcher.adopt(update.meta);
      setStatus("watching");
      setPrompt(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }, [replaceRef]);
  // Auto mode applies from inside the watcher's callback, which captured an
  // older closure; a ref keeps that path on the current apply.
  const applyRef = useLatestRef(apply);

  const canWatch = !!local && isController && isDeckWatchSupported();

  useEffect(() => {
    if (!canWatch) return;
    let cancelled = false;
    idbGet(id)
      .then((rec) => {
        if (cancelled || !rec?.handle) return;
        // The control appears as soon as there's a file to watch, whatever the
        // mode — that's what makes "live reload off" a state you can leave.
        setHasHandle(true);
        if (modeRef.current === "off") return;
        const watcher = new DeckWatcher(rec.handle, {
          onStatus: (next) => {
            if (!cancelled) setStatus(next);
          },
          // Signal only — the File seen at detection is re-read at apply time.
          onUpdate: () => {
            if (cancelled) return;
            setStatus("updated");
            // Auto mode swaps without asking; prompt mode puts the decision
            // (and what it costs) in front of the presenter first.
            if (modeRef.current === "auto") void applyRef.current();
            else setPrompt(true);
          },
        });
        watcherRef.current = watcher;
        void watcher.begin().catch(() => {
          // Unexpected permission-check failure: offer the explicit resume.
          if (!cancelled) setStatus("needs-permission");
        });
      })
      .catch(() => { /* no record, no watcher */ });
    return () => {
      cancelled = true;
      watcherRef.current?.stop();
      watcherRef.current = null;
      setStatus(null);
      setPrompt(false);
    };
  }, [canWatch, id, handleEpoch, mode, modeRef, applyRef]);

  // Persist the live-reload choice per deck, so it survives a reload.
  useEffect(() => {
    if (local && isController) lsSetString(deckWatchKey(id), mode);
  }, [mode, local, isController, id]);

  // Explicit re-grant after a reload dropped the permission. Runs from the
  // pill's click, which is the user gesture requestPermission() needs.
  const resume = useCallback(() => {
    void watcherRef.current?.resume();
  }, []);

  // A replace writes IndexedDB, never the file on disk, so the watcher's
  // reference point is still valid. What can change is *which* file is
  // watched: a pick that came with its own handle replaced the stored one, so
  // restart the watcher against it.
  const rewatch = useCallback(() => setHandleEpoch((n) => n + 1), []);

  const dismissPrompt = useCallback(() => setPrompt(false), []);

  return {
    /** The live-reload mode, or null when this deck has nothing to watch. */
    mode: canWatch && hasHandle ? mode : null,
    setMode,
    status,
    applying,
    apply,
    resume,
    rewatch,
    prompt,
    dismissPrompt,
  };
}
