/**
 * One logo component for every size: the size picks the variant. Below the
 * threshold the fine constellations are dropped (they are sub-pixel noise at
 * 16 px) but the frame and the central star keep the logo gradients; every
 * instance owns its gradient ids so two marks on screen cannot paint each other.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StellarMark } from "@renderer/StellarMark";
import { SMALL_MARK_MAX_PX, markVariant } from "@renderer/stellar-mark-variant";
import { AppLogo } from "@renderer/AppLogo";

const svgOf = (container: HTMLElement) => container.querySelector("svg") as SVGSVGElement;

describe("StellarMark", () => {
  it("picks the variant from the size, with the boundary at SMALL_MARK_MAX_PX", () => {
    expect(markVariant(16)).toBe("small");
    expect(markVariant(24)).toBe("small");
    expect(markVariant(SMALL_MARK_MAX_PX)).toBe("small");
    expect(markVariant(SMALL_MARK_MAX_PX + 1)).toBe("full");
    expect(markVariant(40)).toBe("full");
    expect(markVariant(112)).toBe("full");
  });

  it("small: frame + central star with the gradients, and NO constellation or tiny stars", () => {
    const { container } = render(<StellarMark size={16} />);
    const svg = svgOf(container);
    expect(svg.dataset.markVariant).toBe("small");
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.querySelectorAll("rect")).toHaveLength(1); // the frame
    expect(svg.querySelectorAll("path")).toHaveLength(1); // the central star only
    expect(svg.querySelectorAll("circle")).toHaveLength(0); // no nodes, no tiny stars
    expect(svg.querySelector("rect")!.getAttribute("stroke")).toMatch(/^url\(#stellar-mark-frame-/);
    expect(svg.querySelector("path")!.getAttribute("fill")).toMatch(/^url\(#stellar-mark-star-/);
    // Thicker than the full frame (2.4): it has to survive at 16 px.
    expect(Number(svg.querySelector("rect")!.getAttribute("stroke-width"))).toBeGreaterThan(2.4);
  });

  it("full: the whole logo — frame, star, moon, both constellations and the tiny stars", () => {
    const { container } = render(<StellarMark size={40} />);
    const svg = svgOf(container);
    expect(svg.dataset.markVariant).toBe("full");
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
    expect(svg.querySelectorAll("circle").length).toBeGreaterThanOrEqual(10);
    expect(svg.querySelectorAll("path").length).toBeGreaterThanOrEqual(4);
  });

  it("is decorative unless it is given a title", () => {
    const decorative = svgOf(render(<StellarMark size={16} />).container);
    expect(decorative.getAttribute("aria-hidden")).toBe("true");
    expect(decorative.getAttribute("role")).toBeNull();
    const named = svgOf(render(<StellarMark size={40} title="Stellar" />).container);
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("Stellar");
  });

  it("two instances never share gradient ids", () => {
    // One React root, like the app: `useId` is unique within a root.
    const { container } = render(
      <>
        <StellarMark size={16} />
        <StellarMark size={40} />
      </>,
    );
    const [a, b] = Array.from(container.querySelectorAll("svg")) as SVGSVGElement[];
    const ids = (svg: SVGSVGElement) => Array.from(svg.querySelectorAll("linearGradient")).map((g) => g.id);
    const all = [...ids(a), ...ids(b)];
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
    // and every url(#…) points at an id that exists in ITS OWN svg
    for (const svg of [a, b]) {
      const own = new Set(ids(svg));
      for (const el of Array.from(svg.querySelectorAll("[fill^='url(#'], [stroke^='url(#']"))) {
        for (const attr of ["fill", "stroke"]) {
          const ref = (el.getAttribute(attr) ?? "").match(/^url\(#([^)]+)\)$/)?.[1];
          if (ref !== undefined) expect(own.has(ref)).toBe(true);
        }
      }
    }
  });

  it("AppLogo is the same component at its large size", () => {
    const svg = svgOf(render(<AppLogo />).container);
    expect(svg.dataset.markVariant).toBe("full");
    expect(svg.getAttribute("width")).toBe("112");
    expect(svg.getAttribute("aria-label")).toBe("Stellar");
  });
});
