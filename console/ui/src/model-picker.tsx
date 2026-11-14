/** @jsxImportSource preact */
// A model ID field with the models it can name: focusing it lists them, typing filters them (every word must appear in the
// ID or the name), a click or Enter picks one. An ID that is not listed can still be typed.
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";

export interface PickerModel { id: string; name?: string; contextWindow?: number; maxTokens?: number }
/** Rendered at once; the rest are reached by narrowing the filter. */
const SHOWN = 200;
const limits = (model: PickerModel) => [model.contextWindow && `上下文 ${model.contextWindow}`, model.maxTokens && `输出 ${model.maxTokens}`].filter(Boolean).join(" · ");

export function matchModels<T extends PickerModel>(models: T[], filter: string): T[] {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? models.filter(model => { const text = `${model.id} ${model.name ?? ""}`.toLowerCase(); return words.every(word => text.includes(word)); }) : models;
}

export function ModelPicker<T extends PickerModel>({ label, value, models, onInput, onPick, placeholder }: {
  label: string; value: string; models: T[]; onInput(id: string): void; onPick(model: T): void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false), [filter, setFilter] = useState(""), [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null), listId = useId();
  const matches = useMemo(() => matchModels(models, filter), [models, filter]), shown = matches.slice(0, SHOWN);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [index, open]);
  const pick = (model: T | undefined) => { if (!model) return; onPick(model); setFilter(""); setOpen(false); };
  // Opening shows every model, the current one first in view; typing narrows from there.
  const show = () => { setFilter(""); setIndex(Math.max(0, models.findIndex(model => model.id === value))); setOpen(models.length > 0); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); if (!open) show(); else setIndex(position => Math.min(position + 1, shown.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex(position => Math.max(position - 1, 0)); }
    else if (event.key === "Enter" && open && shown[index]) { event.preventDefault(); pick(shown[index]); }
    else if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  const expanded = open && models.length > 0;
  return <div class="model-picker" onFocusOut={event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <input type="text" role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId}
      aria-activedescendant={expanded && shown[index] ? `${listId}-${index}` : undefined} autoComplete="off" spellcheck={false}
      value={value} placeholder={placeholder} onFocus={show} onClick={() => { if (!open) show(); }} onKeyDown={onKeyDown}
      onInput={event => { const text = event.currentTarget.value; onInput(text); setFilter(text); setIndex(0); setOpen(models.length > 0); }} />
    {expanded && <ul class="model-picker-list" role="listbox" id={listId} ref={list} aria-label={`${label}候选`}>
      {shown.length === 0 && <li class="model-picker-empty" role="presentation">没有匹配的模型；可以直接使用输入的模型 ID</li>}
      {shown.map((model, position) => <li key={model.id} id={`${listId}-${position}`} data-index={position} role="option" aria-selected={position === index}
        class="model-picker-item" onMouseDown={event => event.preventDefault()} onMouseMove={() => setIndex(position)} onClick={() => pick(model)}>
        <span class="model-picker-id">{model.id}</span>
        {(model.name && model.name !== model.id || limits(model)) && <span class="model-picker-detail">{[model.name !== model.id && model.name, limits(model)].filter(Boolean).join(" · ")}</span>}
      </li>)}
      {matches.length > SHOWN && <li class="model-picker-empty" role="presentation">还有 {matches.length - SHOWN} 个，请输入关键词缩小范围</li>}
    </ul>}
  </div>;
}
