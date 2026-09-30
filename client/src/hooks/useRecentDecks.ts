import { useEffect, useState } from "react";
import { listRecentDecks, type RecentDeck } from "@/lib/recentDecks";

/**
 * The recents list, listed on mount and again when the signed-in user
 * changes: signing in pulls the account's decks in, signing out drops back to
 * local-only. Rows change locally through the returned setter (a replace, a
 * close) rather than by re-listing.
 */
export function useRecentDecks(userId: string | undefined) {
  const [recents, setRecents] = useState<RecentDeck[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listRecentDecks().then((list) => {
      if (!cancelled) setRecents(list);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return [recents, setRecents] as const;
}
