import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PortalContext } from "../game/portal";
import { DoctrineBinderPicker } from "./binder/DoctrineBinderPicker";

export {
  loadDoctrinePickerState,
  loadDoctrineSlots,
  saveDoctrinePickerState,
  saveDoctrineSlots,
} from "./doctrineStorage";
export type { CatalogSortKey } from "../game/catalogSort";
export { sortCatalogIds } from "../game/catalogSort";

let pickerRoot: Root | null = null;

export function mountDoctrinePicker(
  rootEl: HTMLElement,
  onStart: (slots: (string | null)[], mapUrl: string) => void,
  portalContext: PortalContext = { enteredViaPortal: false, params: {}, ref: null },
): void {
  if (pickerRoot) pickerRoot.unmount();
  rootEl.style.display = "";
  pickerRoot = createRoot(rootEl);
  pickerRoot.render(
    createElement(DoctrineBinderPicker, {
      portalContext,
      onStart: (slots: (string | null)[], mapUrl: string) => {
        rootEl.style.display = "none";
        onStart(slots, mapUrl);
      },
    }),
  );
}
