import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configurationForm, editConfiguration, type ConfigurationSnapshot } from "../../ops/config/configuration-form.ts";
import { openModelSelection } from "../../src/durable/models.ts";
import { tempFixture } from "../helpers/temp.ts";

const base = (): ConfigurationSnapshot => ({ kind: "models", binding: null, files: {
  models: JSON.stringify({ providers: { openai: { apiKey: "synthetic-test-key", modelOverrides: { "gpt-4o": { name: "Kept name" }, other: { contextWindow: 99999 } } } } }),
  settings: JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o", defaultThinkingLevel: "low", modelThinkingLevels: { "openai/gpt-4o": "high", "other/model": "low" } }),
  catalog: "{}",
} });
const patch = { provider: "openai", mode: "builtin", key: { mode: "keep" }, model: "gpt-4o", thinking: "high", modelLimits: { contextWindow: 64000, maxTokens: 2048 } };

test("global model controls use Pi native overrides; the actual runtime, compaction and model lookup agree", async () => {
  const fixture = await tempFixture("console-model-limits-");
  try {
    expect(configurationForm(base()).thinking).toBe("high"); // Show the selected model's existing override before any edit.
    const next = editConfiguration(base(), patch), source = JSON.parse(next.files.models!), settings = JSON.parse(next.files.settings!);
    expect(source.providers.openai.modelOverrides).toEqual({ "gpt-4o": { name: "Kept name", contextWindow: 64000, maxTokens: 2048 }, other: { contextWindow: 99999 } });
    expect(settings.defaultThinkingLevel).toBe("high");
    expect(settings.modelThinkingLevels).toEqual({ "other/model": "low" });
    expect(settings.modelLimits).toBeUndefined();
    expect(configurationForm(next).providers).toMatchObject([{ id: "openai", overrides: [{ id: "gpt-4o", name: "Kept name", contextWindow: 64000, maxTokens: 2048 }, { id: "other", contextWindow: 99999 }] }]);
    const modelsPath = join(fixture.root, "models.json"), settingsPath = join(fixture.root, "settings.json"), modelsStorePath = join(fixture.root, "catalog.json");
    await Promise.all([writeFile(modelsPath, next.files.models!), writeFile(settingsPath, next.files.settings!), writeFile(modelsStorePath, "{}")]);
    const selected = await openModelSelection({ modelsPath, settingsPath, modelsStorePath });
    expect(selected.model.contextWindow).toBe(64000); expect(selected.model.maxTokens).toBe(2048);
    expect(selected.runtime.getModel("openai", "gpt-4o")?.contextWindow).toBe(64000);
    expect(selected.runtime.getModel("openai", "gpt-4o")?.maxTokens).toBe(2048);
    expect(selected.harnessSettings.compaction?.backgroundTokens).toBe(0); // 64000 - 16384 - 8000 < 2 * 20000
    // Clearing both numeric controls restores native catalogue limits without dropping other metadata.
    const cleared = editConfiguration(next, { ...patch, modelLimits: {} });
    expect(JSON.parse(cleared.files.models!).providers.openai.modelOverrides["gpt-4o"]).toEqual({ name: "Kept name" });
    await writeFile(modelsPath, cleared.files.models!);
    const defaults = await openModelSelection({ modelsPath, settingsPath, modelsStorePath });
    expect(defaults.model.contextWindow).toBeGreaterThan(64000);
  } finally { await fixture.cleanup(); }
});

test("custom model limits are native model fields; invalid limits cannot enter the draft", async () => {
  const fixture = await tempFixture("console-custom-limits-");
  try {
    const original: ConfigurationSnapshot = { kind: "models", binding: null, files: { models: "{}", settings: "{}", catalog: "{}" } };
    const custom = { ...patch, provider: "gateway", mode: "custom", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", key: { mode: "set", value: "synthetic-key" },
      model: { id: "reasoner", contextWindow: 128000, maxTokens: 8000, reasoning: true } };
    const next = editConfiguration(original, custom), config = JSON.parse(next.files.models!);
    expect(config.providers.gateway.models[0]).toMatchObject({ id: "reasoner", contextWindow: 64000, maxTokens: 2048 });
    expect(config.providers.gateway.modelOverrides).toBeUndefined();
    await mkdir(join(fixture.root, "native"));
    const modelsPath = join(fixture.root, "native/models.json"), settingsPath = join(fixture.root, "native/settings.json");
    await Promise.all([writeFile(modelsPath, next.files.models!), writeFile(settingsPath, next.files.settings!)]);
    const selected = await openModelSelection({ modelsPath, settingsPath, modelsStorePath: join(fixture.root, "catalog.json") });
    expect(selected.model.contextWindow).toBe(64000); expect(selected.thinkingLevel).toBe("high");
    for (const value of [0, -1, 1.5, "64000", null, Number.MAX_SAFE_INTEGER + 1])
      expect(() => editConfiguration(original, { ...custom, modelLimits: { contextWindow: value } })).toThrow("正整数");
  } finally { await fixture.cleanup(); }
});
