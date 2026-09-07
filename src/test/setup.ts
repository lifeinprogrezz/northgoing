import "@testing-library/jest-dom";

// Every stub below is a jsdom patch. A test file that opts into the node
// environment (`// @vitest-environment node`, first one: merge-url-variants.test.ts,
// 2026-09-07, which boots an in-process Postgres) still loads this setup file,
// and there `window` and `Element` do not exist. Each stub checks for its host
// object first so such a file can run at all.
const hasDom = typeof window !== "undefined";

// jsdom ships no ResizeObserver; components that watch their own box (HeadBar's
// facet row) construct one on mount. A no-op stub is enough — the tests drive the
// resize-dependent state through explicit events.
if (hasDom && !("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { writable: true, value: ResizeObserverStub });
  Object.defineProperty(globalThis, "ResizeObserver", { writable: true, value: ResizeObserverStub });
}

// jsdom ships no scrollTo on Element; RolesPanel's detail view calls it on
// mount to reset scroll position when the open role changes (issue #158's
// signin test is the first to actually render a detail, not just cards).
if (hasDom && !("scrollTo" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollTo", { writable: true, value: () => {} });
}

if (hasDom) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
