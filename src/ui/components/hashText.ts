// Narrow-screen hash label (T-09): "0x975b…2755" — first 6 chars (incl. 0x) + … + last 4.
// The full value stays available through the link href and title.

const HEAD = 6;
const TAIL = 4;

export const compactHash = (h: string) => (h.length <= HEAD + TAIL + 1 ? h : `${h.slice(0, HEAD)}…${h.slice(-TAIL)}`);
