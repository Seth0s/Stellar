import { StellarMark } from "./StellarMark";

/**
 * The shell screens' (Boot, FirstRun, Login) logo: the same component as the
 * header mark, at the large size where it draws the full artwork with the
 * gradient frame and the constellations.
 */
export function AppLogo({ size = 112 }: { size?: number }) {
  return <StellarMark size={size} title="Stellar" />;
}
