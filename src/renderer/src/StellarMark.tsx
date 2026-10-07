import { useId } from "react";
import { markVariant } from "./stellar-mark-variant";

/**
 * The Stellar logo, one component for every size: the size picks the variant.
 *
 *   - `full` (size > `SMALL_MARK_MAX_PX`, see stellar-mark-variant.ts): the approved logo — gradient frame, the
 *     central star and the constellations. Same artwork as the site logo and
 *     `build/icon.svg`.
 *   - `small` (size <= `SMALL_MARK_MAX_PX`): the same logo with the fine details
 *     dropped — a thicker frame and a larger central star, both with the logo
 *     gradients, no constellations. Below ~24 px a 1px constellation line is
 *     sub-pixel noise; the frame and the star are what survives at 16 px.
 *     `build/icon-small.svg` is the matching variant of the system icon.
 *
 * Gradient ids are made per instance (`useId`): the mark is rendered several times
 * at once (header, settings, shell screens) and a shared id would let one instance's
 * gradient fill another's.
 */

export function StellarMark({ size = 16, title }: { size?: number; title?: string }) {
  // `useId` yields ":r1:", which is a valid id but awkward inside `url(#…)`.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const frameId = `stellar-mark-frame-${uid}`;
  const starId = `stellar-mark-star-${uid}`;
  const small = markVariant(size) === "small";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      data-mark-variant={small ? "small" : "full"}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      <defs>
        <linearGradient id={frameId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3d6bff" />
          <stop offset="0.55" stopColor="#9c8cff" />
          <stop offset="1" stopColor="#c46cf0" />
        </linearGradient>
        <linearGradient id={starId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a9d6ff" />
          <stop offset="0.5" stopColor="#8fa2ff" />
          <stop offset="1" stopColor="#c39cff" />
        </linearGradient>
      </defs>
      {small ? (
        <>
          <rect x="3.5" y="3.5" width="57" height="57" rx="14" fill="none" stroke={`url(#${frameId})`} strokeWidth="5" />
          <path
            d="M32 14c1.5 14.5 5.5 18.5 18 18-12.5.5-16.5 4.5-18 18-1.5-13.5-5.5-17.5-18-18 12.5-.5 16.5-4.5 18-18z"
            fill={`url(#${starId})`}
          />
        </>
      ) : (
        <>
          <rect x="2.5" y="2.5" width="59" height="59" rx="15" fill="none" stroke={`url(#${frameId})`} strokeWidth="2.4" />
          <circle cx="17.5" cy="11.5" r="0.8" fill="#fff1d0" />
          <circle cx="52.5" cy="15" r="0.8" fill="#fff1d0" />
          <circle cx="49" cy="50.5" r="0.8" fill="#fff1d0" />
          <path d="M23.5 12.6A3.4 3.4 0 1 0 26.33 17.89A3 3 0 0 1 23.5 12.6z" fill="#8fa8ff" />
          <path d="M19.6 19.2 13.8 25l4.6 10.7L25 41.5" fill="none" stroke="#8fa2ff" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
          <path d="M42.1 20.9l9.2 5.1 1 7.9-6.9 6.7" fill="none" stroke="#b48cfb" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
          <circle cx="13.8" cy="25" r="1.9" fill="#a9dcff" />
          <circle cx="18.4" cy="35.7" r="1.4" fill="#a9c8ff" />
          <circle cx="25" cy="41.5" r="1.2" fill="#b9a4ff" />
          <circle cx="42.1" cy="20.9" r="1.3" fill="#c9b4ff" />
          <circle cx="51.3" cy="26" r="1.8" fill="#c39cff" />
          <circle cx="52.3" cy="33.9" r="1.4" fill="#c39cff" />
          <circle cx="45.4" cy="40.6" r="1.3" fill="#c39cff" />
          <path
            d="M32.5 18c.9 9.1 3.3 11.6 12.5 12.5-9.2.9-11.6 3.4-12.5 12.5-.9-9.1-3.3-11.6-12.5-12.5 9.2-.9 11.6-3.4 12.5-12.5z"
            fill={`url(#${starId})`}
          />
        </>
      )}
    </svg>
  );
}
