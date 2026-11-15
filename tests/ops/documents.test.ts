import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { createMaintenanceHost, type DataStep } from "../../ops/core/maintenance-host.ts";
import { documentRequest, runDocuments, type DocumentAction } from "../../ops/core/documents.ts";
import { runCore } from "../../ops/core/cli.ts";

test("document maintenance rejects extra arguments before invoking a writer", async () => {
  expect(() => documentRequest("document-check", ["--repair"])).toThrow();
  expect(() => documentRequest("document-unknown", [])).toThrow();
  let calls = 0;
  const documents: typeof runDocuments = async action => {
    calls++;
    return { protocol: "mixin-ops", version: 1, command: action, outcome: "failed", wasRunning: false, finalState: "stopped", exitCode: 7, message: "fixture" };
  };
  const result = await runCore(["maintenance", "document-check", "--project", "."], { documents });
  expect(result.result.exitCode).toBe(7); expect(calls).toBe(1);
  await expect(runCore(["maintenance", "document-check", "--project", ".", "extra"], { documents })).rejects.toThrow();
  await expect(runCore(["maintenance", "document-check", "--project", ".", "--all"], { documents })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("document checks stay online; installation failures still restore the original service state", async () => {
  const f = await tempFixture("document-window-");
  try {
    for (const name of ["console", "ops", "scripts", "src"]) { await mkdir(join(f.root, name)); await writeFile(join(f.root, name, "fixture.ts"), "export {};"); }
    const actions: DocumentAction[] = process.platform === "linux" ? ["document-check"] : ["document-check", "document-install", "document-repair"];
    for (const action of actions) for (const running of [false, true]) for (const failure of ["", "preflight", "work"]) {
      let state: "running" | "stopped" = running ? "running" : "stopped";
      const events: string[] = [], steps: DataStep[] = [];
      const create: typeof createMaintenanceHost = (options, request) => ({ ...createMaintenanceHost(options, request),
        host: {
          locked: body => body(), verify: async () => {}, inspect: async () => ({ identity: "fixture", state, owned: true, ready: state === "running", pending: false }),
          assess: async () => {}, save: async () => {}, finish: async () => {},
          stop: async () => { events.push("stop"); state = "stopped"; }, start: async () => { events.push("start"); state = "running"; }, waitReady: async () => true,
        }, prepare: async () => {},
        data: async step => {
          steps.push(step); events.push(step.args[0]! + ":" + state);
          if (!step.online) expect(state).toBe("stopped");
          return { code: failure === (step.args[0] === "preflight" ? "preflight" : "work") ? 1 : 0, stdout: "" };
        },
      });
      const result = await runDocuments(action, { project: f.root, source: f.root, verify: async () => {}, finish: async () => {} }, undefined, create);
      const initial = running ? "running" : "stopped";
      expect(state).toBe(initial);
      if (action === "document-check") {
        expect(events).toEqual(["check:" + initial]); expect(result.exitCode).toBe(failure === "work" ? 1 : 0);
        expect(steps[0]!.runtimeEnvironment).toBe(true);
        expect(steps[0]!.args).toEqual(process.platform === "linux" ? ["check", "--image"] : ["check"]);
      } else if (failure === "preflight") {
        expect(events).toEqual(["preflight:" + initial]); expect(result.exitCode).toBe(1);
      } else {
        expect(events).toEqual(["preflight:" + initial, ...(running ? ["stop"] : []), action.slice(9) + ":stopped", ...(running ? ["start"] : [])]);
        expect(result.exitCode).toBe(failure === "work" ? 1 : 0);
        expect(steps[1]!.timeoutMs).toBeGreaterThan(30 * 60_000);
      }
    }
    if (process.platform === "linux") expect(() => documentRequest("document-install", [])).toThrow("镜像");
  } finally { await f.cleanup(); }
});
