import { useMediaQuery } from "./useMediaQuery";

// True when the app is running from an installed PWA rather than a browser tab.
// The manifest sets display: standalone, so installed launches report
// `display-mode: standalone`; older iOS builds exposed it as navigator.standalone.
// Checked via media query (with a change listener) plus the legacy property.
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

export function useIsStandalone(): boolean {
  const displayStandalone = useMediaQuery("(display-mode: standalone)");
  return displayStandalone || isStandalone();
}
