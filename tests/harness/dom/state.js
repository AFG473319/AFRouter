// Shared state for one happy-dom render: route, recorded navigations, network and console.
export const harness = {
  pathname: "/dashboard",
  search: "",
  params: {},
  navigations: [],
  network: [],
  console: [],
  pageErrors: [],
  inflight: 0,
  pending: new Set(),
  lastActivity: Date.now(),
  navigate(href, kind) {
    this.navigations.push({ href, kind });
  },
  reset({ pathname = "/dashboard", search = "", params = {} } = {}) {
    Object.assign(this, { pathname, search, params, navigations: [], network: [], console: [], pageErrors: [], inflight: 0, pending: new Set(), lastActivity: Date.now() });
  },
};
