import { useEffect, useRef } from "react";

/**
 * A ref that follows a value, for reading it back from somewhere that isn't a
 * render: a socket handler, a timer, an event listener subscribed once.
 *
 * The point is to keep those callbacks off the value's identity — a socket
 * effect that re-subscribed on every slide change would drop messages — while
 * still letting them see the current value. The ref is written after commit
 * rather than during render (writing a ref while rendering is what
 * `react-hooks/refs` forbids: a render that React throws away would leave the
 * ref holding state that never reached the screen), so read it from callbacks,
 * never as a shortcut to this render's value.
 */
export function useLatestRef<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
