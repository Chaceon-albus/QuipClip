/*
 * Applies the colour theme before the first paint.
 *
 * index.html loads this file as a plain script at the top of <head>, before the stylesheet
 * and the application module. The palette therefore finds the right class on <html> when it
 * first applies, and a dark system does not show a light first frame.
 *
 * The rule is the one in src/lib/theme.ts, and the storage key is the one in
 * src/features/settings/themePreference.ts. This file cannot import them, so a change there
 * must change this file too. src/lib/theme.test.ts runs this file and compares the result.
 *
 * The file is ES5 with no imports. Every failure leaves the page as it is, and the module
 * code writes the theme again when it starts.
 */
(function () {
  try {
    var root = document.documentElement;
    var preference = null;
    try {
      preference = window.localStorage.getItem("quipclip.theme_preference");
    } catch (storageError) {
      // Storage can be missing or can throw. The preference then reads as "system".
    }
    var dark;
    if (preference === "dark") {
      dark = true;
    } else if (preference === "light") {
      dark = false;
    } else {
      dark = !!(
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      );
    }
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (error) {
    // The module code applies the theme when it starts.
  }
})();
