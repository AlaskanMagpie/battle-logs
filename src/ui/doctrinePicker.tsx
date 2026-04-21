import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DoctrineBinderPicker } from "./binder/DoctrineBinderPicker";

export { loadDoctrineSlots, saveDoctrineSlots } from "./doctrineStorage";
export type { CatalogSortKey } from "../game/catalogSort";
export { sortCatalogIds } from "../game/catalogSort";

let pickerRoot: Root | null = null;

export function mountDoctrinePicker(rootEl: HTMLElement, onStart: (slots: (string | null)[]) => void): void {
  if (pickerRoot) pickerRoot.unmount();
  pickerRoot = createRoot(rootEl);
  pickerRoot.render(
    createElement(DoctrineBinderPicker, {
      onStart: (slots: (string | null)[]) => {
        rootEl.style.display = "none";
        onStart(slots);
      },
    }),
  );
}
