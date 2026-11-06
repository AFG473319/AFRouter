// Agent harness: flow step language (scripts/agent/lib/flow.mjs).
import { describe, it, expect } from "vitest";
import { parseTarget, parseFlow, parseStep, describeTarget, checkApiExpectations, getPath, nameMatcher } from "../../scripts/agent/lib/flow.mjs";

describe("parseTarget", () => {
  it.each([
    ["Save", { text: "Save" }],
    ["text=Save changes", { text: "Save changes" }],
    ["role=button", { role: "button" }],
    ["role=button[name=Create Key]", { role: "button", name: "Create Key" }],
    ["role=button[name=\"Create\"][exact=true]", { role: "button", name: "Create", exact: true }],
    ["role=tab[name=Usage][nth=1]", { role: "tab", name: "Usage", nth: 1 }],
    ["label=Key Name", { label: "Key Name" }],
    ["placeholder=Search providers...", { placeholder: "Search providers..." }],
    ["testid=save-btn", { testId: "save-btn" }],
    ["css=.card > button", { css: ".card > button" }],
    ["unknown=thing", { text: "unknown=thing" }],
  ])("%s", (input, expected) => {
    expect(parseTarget(input)).toEqual(expected);
  });

  it("accepts object form and normalizes testid", () => {
    expect(parseTarget({ testid: "x" })).toEqual({ testId: "x" });
    expect(parseTarget({ role: "link", name: "Docs", nth: 0 })).toEqual({ role: "link", name: "Docs", nth: 0 });
  });

  it("rejects ambiguous or empty targets", () => {
    expect(() => parseTarget("")).toThrow(/missing target/);
    expect(() => parseTarget({ role: "button", text: "x" })).toThrow(/exactly one/);
    expect(() => parseTarget({ text: "x", nth: -1 })).toThrow(/nth/);
    expect(() => parseTarget("role=button[colour=red]")).toThrow(/unknown role attribute/);
  });
});

describe("parseStep / parseFlow", () => {
  it("normalizes a full flow", () => {
    const flow = parseFlow({
      name: "keys",
      route: "/dashboard/endpoint",
      steps: [
        { click: "role=button[name=Create Key]" },
        { fill: "placeholder=Production Key", value: "ci" },
        { press: "Enter" },
        { wait: 300 },
        { wait: "text=ci" },
        { expect: "role=row", count: 2 },
        { api: { path: "/api/keys", json: { "keys.length": 2 } } },
        { snap: true },
      ],
    });
    expect(flow.name).toBe("keys");
    expect(flow.steps.map((s) => s.action)).toEqual(["click", "fill", "press", "wait", "wait", "expect", "api", "snap"]);
    expect(flow.steps[1]).toMatchObject({ i: 2, target: { placeholder: "Production Key" }, value: "ci" });
    expect(flow.steps[3]).toMatchObject({ ms: 300 });
    expect(flow.steps[4].target).toEqual({ text: "ci" });
    expect(flow.steps[5].count).toBe(2);
    expect(flow.steps[6].api).toMatchObject({ method: "GET", path: "/api/keys" });
  });

  it("defaults the route to /dashboard and accepts JSON text", () => {
    expect(parseFlow('{"steps":[{"snap":true}]}').route).toBe("/dashboard");
  });

  it("gives step-numbered errors an agent can act on", () => {
    expect(() => parseFlow({ steps: [] })).toThrow(/non-empty steps/);
    expect(() => parseFlow({ route: "dashboard", steps: [{ snap: true }] })).toThrow(/route must start with \//);
    expect(() => parseStep({ fill: "label=Name" }, 2)).toThrow(/step 3 \(fill\): "fill" needs "value"/);
    expect(() => parseStep({ click: "a", fill: "b" }, 0)).toThrow(/exactly one action/);
    expect(() => parseStep({ goto: "dashboard" }, 0)).toThrow(/route starting with/);
    expect(() => parseStep({ api: {} }, 0)).toThrow(/"api" needs/);
    expect(() => parseStep("click", 0)).toThrow(/must be an object/);
  });

  it("keeps optional and timeout modifiers", () => {
    expect(parseStep({ click: "x", optional: true, timeout: 9000 }, 0)).toMatchObject({ optional: true, timeout: 9000 });
  });
});

describe("helpers", () => {
  it("describeTarget is short and readable", () => {
    expect(describeTarget({ role: "button", name: "Save" })).toBe('button "Save"');
    expect(describeTarget({ label: "Name", nth: 1 })).toBe('label="Name" #1');
  });

  it("nameMatcher is a case-insensitive substring unless exact", () => {
    expect(nameMatcher("create key").test("Create Key")).toBe(true);
    expect(nameMatcher("a.b").test("axb")).toBe(false);
    expect(nameMatcher("Create", true)).toBe("Create");
    expect(nameMatcher(undefined)).toBeUndefined();
  });

  it("getPath walks dotted paths including array indexes and length", () => {
    const obj = { keys: [{ name: "a" }, { name: "b" }] };
    expect(getPath(obj, "keys.1.name")).toBe("b");
    expect(getPath(obj, "keys.length")).toBe(2);
    expect(getPath(obj, "nope.deeper")).toBeUndefined();
  });

  it("checkApiExpectations reports status and json mismatches", () => {
    const step = { api: { status: 200, json: { "keys.length": { gte: 2 }, "keys.0.name": "a", missing: { exists: false } } } };
    expect(checkApiExpectations(step, { status: 200, json: { keys: [{ name: "a" }, { name: "b" }] } })).toEqual([]);
    const problems = checkApiExpectations(step, { status: 500, json: { keys: [{ name: "z" }] } });
    expect(problems[0]).toMatch(/status 500 != 200/);
    expect(problems.join(" ")).toMatch(/keys.length/);
    expect(checkApiExpectations({ api: {} }, { status: 404 })).toEqual(["status 404"]);
  });
});
