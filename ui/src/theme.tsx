import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";

const Preference = Schema.Literals(["system", "light", "dark"]);
type ThemePreference = typeof Preference.Type;
const isPreference = Schema.is(Preference);
const storageKey = "supervisor-color-scheme";
type ThemeState = { readonly preference: ThemePreference; readonly persisted: boolean };

const readPreference = (): ThemeState => {
  try {
    const value = localStorage.getItem(storageKey);
    return {preference: isPreference(value) ? value : "system", persisted: true};
  } catch {
    return {preference: "system", persisted: false};
  }
};
const applyPreference = (preference: ThemePreference) => {
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", preference === "system" ? "light dark" : preference);
};

// this small browser adapter owns its storage listener in the registry; CSS follows system changes without a JS media listener
export const themeAtom = Atom.keepAlive(Atom.writable<ThemeState, ThemePreference>((get) => {
  if (typeof window === "undefined") return {preference: "system", persisted: true};
  const initial = readPreference();
  applyPreference(initial.preference);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    const current = readPreference();
    applyPreference(current.preference);
    get.setSelf(current);
  };
  window.addEventListener("storage", onStorage);
  get.addFinalizer(() => window.removeEventListener("storage", onStorage));
  return initial;
}, (get, preference) => {
  applyPreference(preference);
  let persisted = true;
  try {
    if (preference === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, preference);
  } catch {
    persisted = false;
  }
  get.setSelf({preference, persisted});
}));

export function ThemeSelector() {
  const {preference, persisted} = useAtomValue(themeAtom);
  const setTheme = useAtomSet(themeAtom);
  return <section className="settings-group stack">
    <h2>Appearance</h2>
    <label className="theme-control" htmlFor="theme-preference"><span>Theme</span>
      <select id="theme-preference" value={preference} onChange={event => {
        if (isPreference(event.target.value)) setTheme(event.target.value);
      }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
    </label>
    <p className="small muted">{persisted ? "Saved in this browser. System follows your device’s appearance." : "Applied for this page. Browser storage is unavailable, so this choice cannot be saved."}</p>
  </section>;
}
