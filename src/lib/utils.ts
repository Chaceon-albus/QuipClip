import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * globals.css adds the shadow sizes `floating` and `dialog`. The default tailwind-merge
 * config does not know them and treats `shadow-floating` as a shadow colour. Then
 * `shadow-none` does not replace it, and `shadow-black/20` removes it. Registering the
 * names as theme shadows puts them in the shadow size group.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ["floating", "dialog"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
